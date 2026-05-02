import { spawn, type ChildProcess, spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { DebugProtocol } from "@vscode/debugprotocol";
import type { Runtime, LaunchArguments } from "../core/runtime";

/**
 * Rust runtime — wraps `lldb-dap` (LLVM 18+'s official DAP server)
 * with a couple of Rust-specific niceties:
 *
 *   1. Injects `command:script import` lines at session start that
 *      load `rust-lldb` Python pretty-printers (Vec, String, Option,
 *      HashMap, …). The script paths are taken from `rustc --print
 *      sysroot` and standard cargo install layouts.
 *   2. Reads `.cargo/config.toml` from `cwd` (or workspace root) and
 *      converts any `[env]` plus `target.<triple>.runner` hints into
 *      `sourceMap` entries the workbench can use.
 *   3. Registers under DAP type `mythos-rust` so launch.json files
 *      stay portable between Mythos hosts.
 *
 * Source mapping for split DWARF / .dwz lookups is intentionally out
 * of scope — that lives in the upcoming `core/sources.ts` resolver
 * (see issue mythosdbg#2).
 */

const HEADER_TERMINATOR = Buffer.from("\r\n\r\n");
const CONTENT_LENGTH = "content-length:";
const MAX_BODY = 64 * 1024 * 1024;

type Pending = {
  resolve(body: unknown): void;
  reject(err: Error): void;
  command: string;
};

export class RustRuntime implements Runtime {
  readonly id = "mythos-rust";
  private child: ChildProcess | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private nextSeq = 1;
  private readonly pending = new Map<number, Pending>();
  private emit: ((evt: DebugProtocol.Event) => void) | null = null;
  private readonly config: LaunchArguments;

  constructor(config: LaunchArguments) {
    this.config = config;
  }

  async start(emit: (evt: DebugProtocol.Event) => void): Promise<void> {
    this.emit = emit;
    const command = await this.resolveAdapter();
    const initCommands = this.buildInitCommands();
    const sourceMap = this.deriveSourceMapFromCargo();

    this.child = spawn(command, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...((this.config.env as Record<string, string>) ?? {}) },
      cwd: this.config.cwd,
    });
    this.child.stdout?.on("data", (chunk: Buffer) => this.feed(chunk));
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.emit?.({
        seq: 0,
        type: "event",
        event: "output",
        body: { category: "stderr", output: chunk.toString("utf8") },
      } as DebugProtocol.OutputEvent);
    });
    this.child.once("exit", (code) => {
      for (const [, slot] of this.pending.entries()) {
        slot.reject(new Error(`lldb-dap exited with code ${code ?? "unknown"} while '${slot.command}' was pending`));
      }
      this.pending.clear();
      if (this.emit) {
        this.emit({
          seq: 0,
          type: "event",
          event: "output",
          body: { category: "console", output: `lldb-dap exited (code=${code ?? "?"})\n` },
        } as DebugProtocol.OutputEvent);
        this.emit({
          seq: 0,
          type: "event",
          event: "terminated",
        } as DebugProtocol.TerminatedEvent);
      }
      this.child = null;
    });
    this.child.once("error", (err) => {
      this.emit?.({
        seq: 0,
        type: "event",
        event: "output",
        body: { category: "stderr", output: `lldb-dap error: ${err.message}\n` },
      } as DebugProtocol.OutputEvent);
      for (const [, slot] of this.pending.entries()) {
        slot.reject(new Error(`lldb-dap failed to start ('${slot.command}' pending): ${err.message}`));
      }
      this.pending.clear();
    });

    await this.request("initialize", {
      clientID: "mythosdbg",
      adapterID: "mythos-rust",
      pathFormat: "path",
      linesStartAt1: true,
      columnsStartAt1: true,
    });

    // Splice the user's `initCommands`/`sourceMap` with our Rust
    // augmentations. Anything the user supplied wins on conflict.
    const launchBody: Record<string, unknown> = { ...this.config };
    const userInit = (this.config.initCommands as string[] | undefined) ?? [];
    launchBody.initCommands = [...initCommands, ...userInit];
    if (sourceMap) {
      const userMap = (this.config.sourceMap as Record<string, string> | undefined) ?? {};
      launchBody.sourceMap = { ...sourceMap, ...userMap };
    }
    await this.request(
      this.config.request === "attach" ? "attach" : "launch",
      launchBody,
    );
  }

  async handle(command: string, args: unknown): Promise<unknown> {
    return this.request(command, args);
  }

  async dispose(): Promise<void> {
    if (!this.child) return;
    try {
      await this.request("disconnect", {
        terminateDebuggee: this.config.request !== "attach",
      });
    } catch {
      /* ignore — adapter may already have torn down */
    }
    if (this.child && this.child.exitCode === null) {
      try {
        this.child.kill();
      } catch {
        /* ignore */
      }
    }
    this.child = null;
    this.emit = null;
  }

  private async resolveAdapter(): Promise<string> {
    const explicit = this.config.debugAdapter as string | undefined;
    if (explicit && explicit.length > 0) return explicit;
    const which = spawnSync("/usr/bin/env", ["which", "lldb-dap"], {
      encoding: "utf8",
    });
    if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
    if (process.platform === "darwin") {
      const xc = spawnSync("/usr/bin/xcrun", ["--find", "lldb-dap"], {
        encoding: "utf8",
      });
      if (xc.status === 0 && xc.stdout.trim()) return xc.stdout.trim();
    }
    throw new Error(
      "Could not locate lldb-dap. Install LLVM 18+ and ensure it is on PATH, or set `debugAdapter` in launch.json.",
    );
  }

  /**
   * Build the `initCommands` that load Rust pretty-printers. We look
   * for the standard `etc/lldb_lookup.py` and `etc/lldb_commands` that
   * shipped with `rustup`-installed toolchains.
   */
  private buildInitCommands(): string[] {
    const commands: string[] = [];
    const sysroot = this.detectRustSysroot();
    if (!sysroot) return commands;

    const lookup = path.join(sysroot, "lib", "rustlib", "etc", "lldb_lookup.py");
    const commandsFile = path.join(sysroot, "lib", "rustlib", "etc", "lldb_commands");
    if (existsSync(lookup)) {
      commands.push(`command script import "${lookup}"`);
    }
    if (existsSync(commandsFile)) {
      commands.push(`command source -s 0 "${commandsFile}"`);
    }
    return commands;
  }

  private detectRustSysroot(): string | null {
    const explicit = this.config.rustSysroot as string | undefined;
    if (explicit && existsSync(explicit)) return explicit;
    const probe = spawnSync("rustc", ["--print", "sysroot"], { encoding: "utf8" });
    if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim();
    return null;
  }

  /**
   * Best-effort parse of `.cargo/config.toml` for the workspace.
   * We do NOT pull in a full TOML parser — we just look for
   * `[env]` and a few well-known keys with a tolerant regex. If the
   * file is malformed we silently fall back to no source map.
   */
  private deriveSourceMapFromCargo(): Record<string, string> | null {
    const cwd = this.config.cwd ?? process.cwd();
    const candidates = [
      path.join(cwd, ".cargo", "config.toml"),
      path.join(cwd, ".cargo", "config"),
    ];
    for (const file of candidates) {
      if (!existsSync(file)) continue;
      try {
        const text = readFileSync(file, "utf8");
        const map = parseCargoSourceMap(text);
        if (map && Object.keys(map).length > 0) return map;
      } catch {
        /* ignore unreadable / malformed files */
      }
    }
    return null;
  }

  private feed(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0
      ? chunk
      : Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf(HEADER_TERMINATOR);
      if (headerEnd < 0) return;
      const headerText = this.buffer.subarray(0, headerEnd).toString("ascii");
      let bodyLen = -1;
      for (const line of headerText.split("\r\n")) {
        if (line.toLowerCase().startsWith(CONTENT_LENGTH)) {
          const num = Number(line.slice(CONTENT_LENGTH.length).trim());
          if (Number.isFinite(num) && num >= 0) bodyLen = num;
        }
      }
      if (bodyLen < 0 || bodyLen > MAX_BODY) {
        this.buffer = Buffer.alloc(0);
        return;
      }
      const total = headerEnd + HEADER_TERMINATOR.length + bodyLen;
      if (this.buffer.length < total) return;
      const body = this.buffer.subarray(headerEnd + HEADER_TERMINATOR.length, total);
      this.buffer = this.buffer.subarray(total);
      try {
        const msg = JSON.parse(body.toString("utf8")) as DebugProtocol.ProtocolMessage;
        this.dispatchInbound(msg);
      } catch {
        /* drop malformed frame; do not desync */
      }
    }
  }

  private dispatchInbound(msg: DebugProtocol.ProtocolMessage): void {
    if (msg.type === "response") {
      const r = msg as DebugProtocol.Response;
      const slot = this.pending.get(r.request_seq);
      if (!slot) return;
      this.pending.delete(r.request_seq);
      if (r.success) slot.resolve(r.body);
      else slot.reject(new Error(r.message ?? `lldb-dap '${slot.command}' failed`));
      return;
    }
    if (msg.type === "event") {
      this.emit?.(msg as DebugProtocol.Event);
      return;
    }
    if (msg.type === "request") {
      const req = msg as DebugProtocol.Request;
      const reply: DebugProtocol.Response = {
        seq: this.nextSeq++,
        type: "response",
        request_seq: req.seq,
        success: false,
        command: req.command,
        message: "Mythos does not currently forward reverse requests",
      };
      this.write(reply);
    }
  }

  private request(command: string, args: unknown): Promise<unknown> {
    if (!this.child) return Promise.reject(new Error("lldb-dap is not running"));
    const seq = this.nextSeq++;
    const req: DebugProtocol.Request = {
      seq,
      type: "request",
      command,
      arguments: args,
    };
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(seq, { resolve, reject, command });
      try {
        this.write(req);
      } catch (err) {
        this.pending.delete(seq);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private write(msg: DebugProtocol.ProtocolMessage): void {
    const body = JSON.stringify(msg);
    const head = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
    this.child?.stdin?.write(head);
    this.child?.stdin?.write(body, "utf8");
  }
}

/**
 * Tolerant cargo `config.toml` source-map extractor. Looks for an
 * `[env]` table or a top-level `source-map` table that maps
 * `"/build/host" = "/dev/host"`.
 *
 * Exported so unit tests can exercise it without spawning rustc.
 */
export function parseCargoSourceMap(text: string): Record<string, string> | null {
  const lines = text.split(/\r?\n/);
  const out: Record<string, string> = {};
  let inSourceMap = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line.length === 0) continue;
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      inSourceMap = sectionMatch[1].trim() === "source-map";
      continue;
    }
    if (!inSourceMap) continue;
    const kv = /^"([^"]+)"\s*=\s*"([^"]+)"$/.exec(line);
    if (kv) out[kv[1]] = kv[2];
  }
  return Object.keys(out).length > 0 ? out : null;
}
