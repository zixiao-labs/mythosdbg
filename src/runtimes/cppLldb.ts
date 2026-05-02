import { spawn, type ChildProcess, spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import path from "node:path";
import type { DebugProtocol } from "@vscode/debugprotocol";
import type { Runtime, LaunchArguments } from "../core/runtime";

/**
 * C/C++ runtime — wraps `lldb-dap` (LLVM 18+'s official DAP server)
 * as a child process and proxies DAP frames. The wrapper is what
 * gives Mythos a place to add value-add features later (custom
 * source mapping, snapshot capture, distributed debug, …) without
 * forking lldb.
 *
 * Discovery order:
 *   1. `config.debugAdapter` if the user pins one in launch.json
 *   2. `lldb-dap` on PATH
 *   3. `xcrun --find lldb-dap` (macOS only)
 *
 * If none resolve, `start()` rejects with a helpful error so the
 * Mythos session surfaces it as an unsuccessful `launch` response.
 *
 * Tracking issue (mythosdbg): Windows support (cdb / windbg) is not
 * implemented. See the Stage 3.5 plan H.4 for the open issue list.
 */

const HEADER_TERMINATOR = Buffer.from("\r\n\r\n");
const CONTENT_LENGTH = "content-length:";
const MAX_BODY = 64 * 1024 * 1024;

type Pending = {
  resolve(body: unknown): void;
  reject(err: Error): void;
  command: string;
};

export class CppLldbRuntime implements Runtime {
  readonly id = "mythos-cpp";
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
      // Reject all pending requests with a descriptive error
      for (const [seq, slot] of this.pending.entries()) {
        slot.reject(new Error(`lldb-dap exited with code ${code ?? "unknown"} while '${slot.command}' was pending`));
      }
      this.pending.clear();

      if (this.emit) {
        this.emit({
          seq: 0,
          type: "event",
          event: "output",
          body: {
            category: "console",
            output: `lldb-dap exited (code=${code ?? "?"})\n`,
          },
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
        body: {
          category: "stderr",
          output: `lldb-dap error: ${err.message}\n`,
        },
      } as DebugProtocol.OutputEvent);
    });

    await this.request("initialize", {
      clientID: "mythosdbg",
      adapterID: "mythos-cpp",
      pathFormat: "path",
      linesStartAt1: true,
      columnsStartAt1: true,
    });
    await this.request("launch", this.config);
  }

  async handle(command: string, args: unknown): Promise<unknown> {
    return this.request(command, args);
  }

  async dispose(): Promise<void> {
    if (!this.child) return;
    try {
      await this.request("disconnect", { terminateDebuggee: true });
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
    // Reverse requests (e.g. runInTerminal) — Mythos doesn't yet
    // forward these to the IDE; respond unsuccessfully so lldb-dap
    // doesn't hang.
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

void path;
