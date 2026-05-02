import { spawn, type ChildProcess, spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import type { DebugProtocol } from "@vscode/debugprotocol";
import type { Runtime, LaunchArguments } from "../core/runtime";

/**
 * Python runtime — wraps Microsoft's `debugpy` adapter (which already
 * speaks DAP) as a child process and proxies DAP frames. The wrapper
 * gives Mythos a place to add value-add features later (custom source
 * mapping, snapshot capture, distributed debug, …) without forking
 * debugpy itself.
 *
 * Discovery order:
 *   1. `config.debugAdapter` — explicit adapter command line
 *   2. `config.python` — Python interpreter to host debugpy
 *   3. `PYTHON` env var
 *   4. Platform default (`python3` on POSIX, `py -3` / `python.exe` on
 *      Windows) resolved through PATH
 *
 * If the chosen interpreter cannot import `debugpy`, `start()` rejects
 * with an actionable error pointing the user at
 * `python -m pip install debugpy`. We intentionally do NOT pip-install
 * silently; that should be a Logos-side opt-in setting (tracked in the
 * Stage 3.5 follow-up plan).
 */

const HEADER_TERMINATOR = Buffer.from("\r\n\r\n");
const CONTENT_LENGTH = "content-length:";
const MAX_BODY = 64 * 1024 * 1024;

type Pending = {
  resolve(body: unknown): void;
  reject(err: Error): void;
  command: string;
};

export class PythonRuntime implements Runtime {
  readonly id = "mythos-python";
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
    const { command, args } = await this.resolveAdapter();
    this.child = spawn(command, args, {
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
        slot.reject(new Error(`debugpy exited with code ${code ?? "unknown"} while '${slot.command}' was pending`));
      }
      this.pending.clear();
      if (this.emit) {
        this.emit({
          seq: 0,
          type: "event",
          event: "output",
          body: { category: "console", output: `debugpy exited (code=${code ?? "?"})\n` },
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
        body: { category: "stderr", output: `debugpy error: ${err.message}\n` },
      } as DebugProtocol.OutputEvent);
    });

    await this.request("initialize", {
      clientID: "mythosdbg",
      adapterID: "mythos-python",
      pathFormat: "path",
      linesStartAt1: true,
      columnsStartAt1: true,
    });
    await this.request(this.config.request === "attach" ? "attach" : "launch", this.config);
  }

  async handle(command: string, args: unknown): Promise<unknown> {
    return this.request(command, args);
  }

  async dispose(): Promise<void> {
    if (!this.child) return;
    try {
      await this.request("disconnect", { terminateDebuggee: this.config.request !== "attach" });
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

  private async resolveAdapter(): Promise<{ command: string; args: string[] }> {
    const explicit = this.config.debugAdapter as string | undefined;
    if (explicit && explicit.length > 0) {
      // Treat the explicit value as a single executable; users with
      // arguments embed them via `debugAdapterArgs`.
      const extra = (this.config.debugAdapterArgs as string[] | undefined) ?? [];
      return { command: explicit, args: extra };
    }
    const interpreter = this.resolvePython();
    this.assertDebugpyImportable(interpreter);
    return { command: interpreter, args: ["-m", "debugpy.adapter"] };
  }

  private resolvePython(): string {
    const explicit = this.config.python as string | undefined;
    if (explicit && explicit.length > 0) return explicit;
    const fromEnv = process.env.PYTHON;
    if (fromEnv && fromEnv.length > 0) return fromEnv;
    if (process.platform === "win32") {
      // Prefer the launcher when available; PowerShell users typically
      // alias `python` to `py -3`.
      const py = spawnSync("where", ["py"], { encoding: "utf8" });
      if (py.status === 0 && py.stdout.trim()) return "py";
      const pyexe = spawnSync("where", ["python"], { encoding: "utf8" });
      if (pyexe.status === 0 && pyexe.stdout.trim()) {
        return pyexe.stdout.split(/\r?\n/)[0].trim();
      }
      return "python";
    }
    const which3 = spawnSync("/usr/bin/env", ["which", "python3"], {
      encoding: "utf8",
    });
    if (which3.status === 0 && which3.stdout.trim()) return which3.stdout.trim();
    const which = spawnSync("/usr/bin/env", ["which", "python"], {
      encoding: "utf8",
    });
    if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
    throw new Error(
      "Could not locate a Python interpreter. Install Python 3.8+ and ensure it is on PATH, or set `python` in launch.json.",
    );
  }

  private assertDebugpyImportable(interpreter: string): void {
    const probe = spawnSync(
      interpreter,
      // The launcher (`py`) needs `-3` to disambiguate; bare interpreters ignore it.
      interpreter.endsWith("py") || interpreter === "py"
        ? ["-3", "-c", "import debugpy"]
        : ["-c", "import debugpy"],
      { encoding: "utf8" },
    );
    if (probe.status !== 0) {
      const hint = `${interpreter} -m pip install debugpy`;
      throw new Error(
        `Python interpreter '${interpreter}' cannot import debugpy. Install it with: ${hint}`,
      );
    }
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
      else slot.reject(new Error(r.message ?? `debugpy '${slot.command}' failed`));
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
    if (!this.child) return Promise.reject(new Error("debugpy is not running"));
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
