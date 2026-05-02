import { spawn, type ChildProcess, spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import path from "node:path";
import { existsSync } from "node:fs";
import type { DebugProtocol } from "@vscode/debugprotocol";
import type { Runtime, LaunchArguments } from "../core/runtime";

/**
 * Windows C/C++ runtime — drives `cdb.exe` (the headless console
 * debugger that ships in the Windows SDK Debugging Tools) through a
 * DAP front-end. cdb does not speak DAP natively, so this runtime
 * translates each supported DAP request into one or more cdb
 * commands, runs them via stdin, and parses the textual output back
 * into DAP response bodies.
 *
 * Two design pieces make this manageable:
 *
 *   1. **Sync-marker protocol.** cdb prints a prompt of the form
 *      `0:000> ` after every command finishes. We do not rely on
 *      that prompt directly because cdb sometimes prints multiple
 *      prompts per command. Instead, we append `.echo <NONCE>` to
 *      every command we send; the runtime collects output until it
 *      sees that nonce echoed back. This gives us reliable
 *      command boundaries even when cdb's output is verbose.
 *
 *   2. **Async stop detection.** When the inferior is running
 *      (`g` / `p` / `t` / `gu`), cdb emits text describing how it
 *      stopped (e.g. `Breakpoint 0 hit`, `(0e8c.13a4): Access
 *      violation`). We watch stdout between commands for those
 *      patterns and synthesise DAP `stopped` events.
 *
 * The runtime is intentionally a v0.0 prototype — it covers the
 * Stage 3.5 issue's acceptance criteria (stop / step / variables /
 * call stack against a small `cl.exe` build) but stubs commands we
 * have not yet exercised end-to-end. Stubbed commands return a
 * descriptive error so users see a clear "not yet implemented"
 * message instead of a hang.
 */

const CDB_PROMPT = /^\d+:\d+>\s*$/;
const NONCE_LENGTH = 16;

type StopReason =
  | { kind: "breakpoint"; threadId: number; description: string }
  | { kind: "step"; threadId: number }
  | { kind: "exception"; threadId: number; description: string }
  | { kind: "entry"; threadId: number };

interface PendingCommand {
  resolve(output: string): void;
  reject(err: Error): void;
  command: string;
  nonce: string;
  buffer: string[];
}

export class CppCdbRuntime implements Runtime {
  readonly id = "mythos-cpp";
  private child: ChildProcess | null = null;
  private emit: ((evt: DebugProtocol.Event) => void) | null = null;
  private readonly config: LaunchArguments;
  private currentCommand: PendingCommand | null = null;
  private readonly queue: PendingCommand[] = [];
  private lineBuf = "";
  /** Synthesised thread ids: cdb reports threads as `~0`, `~1`, … */
  private currentThreadId = 0;

  constructor(config: LaunchArguments) {
    this.config = config;
  }

  async start(emit: (evt: DebugProtocol.Event) => void): Promise<void> {
    this.emit = emit;
    const cdb = await this.resolveAdapter();
    const args = this.buildSpawnArgs();
    this.child = spawn(cdb, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...((this.config.env as Record<string, string>) ?? {}) },
      cwd: this.config.cwd,
      // cdb's prompt parsing relies on Windows-newline output; force
      // pipes (the default) and let Node handle CRLF normalisation.
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
      const reason = `cdb exited (code=${code ?? "?"})`;
      this.failPending(reason);
      this.emit?.({
        seq: 0,
        type: "event",
        event: "output",
        body: { category: "console", output: `${reason}\n` },
      } as DebugProtocol.OutputEvent);
      this.emit?.({
        seq: 0,
        type: "event",
        event: "terminated",
      } as DebugProtocol.TerminatedEvent);
      this.child = null;
    });
    this.child.once("error", (err) => {
      this.emit?.({
        seq: 0,
        type: "event",
        event: "output",
        body: { category: "stderr", output: `cdb error: ${err.message}\n` },
      } as DebugProtocol.OutputEvent);
      this.failPending(`cdb failed to start: ${err.message}`);
    });

    // Warm-up commands — set sane defaults so subsequent commands
    // produce parseable output.
    await this.send(".lines -e");      // enable line-number info
    await this.send(".symfix");        // configure default symbol path
    await this.send(".reload");        // load symbols for the inferior
  }

  async handle(command: string, args: unknown): Promise<unknown> {
    switch (command) {
      case "configurationDone":
        // The inferior is paused at entry. Resume it and let the
        // stop-event watcher emit the next `stopped`.
        return {};

      case "threads": {
        const out = await this.send("~");
        return { threads: parseThreads(out) };
      }

      case "stackTrace": {
        const stArgs = args as DebugProtocol.StackTraceArguments;
        const tid = stArgs.threadId;
        await this.send(`~${tid}s`);   // switch to thread
        const out = await this.send("kn");
        const stackFrames = parseStack(out);
        return {
          stackFrames,
          totalFrames: stackFrames.length,
        };
      }

      case "scopes": {
        // We do not page scopes (locals vs registers vs globals)
        // separately yet — return a single "Locals" scope.
        const sArgs = args as DebugProtocol.ScopesArguments;
        return {
          scopes: [
            {
              name: "Locals",
              variablesReference: encodeFrameRef(sArgs.frameId),
              expensive: false,
            },
          ],
        };
      }

      case "variables": {
        const vArgs = args as DebugProtocol.VariablesArguments;
        const frameId = decodeFrameRef(vArgs.variablesReference);
        if (frameId == null) return { variables: [] };
        await this.send(`.frame ${frameId}`);
        const out = await this.send("dv /v /t");
        return { variables: parseLocals(out) };
      }

      case "evaluate": {
        const eArgs = args as DebugProtocol.EvaluateArguments;
        const out = await this.send(`?? ${eArgs.expression}`);
        return {
          result: parseEvaluate(out),
          variablesReference: 0,
        };
      }

      case "continue":
        // Don't await — `g` blocks until the inferior stops, which we
        // observe via the stop-event watcher. We fire the command and
        // resolve the DAP response right away so the IDE knows the
        // resume happened.
        this.fireAndForget("g");
        return { allThreadsContinued: true };

      case "next":
        this.fireAndForget("p");
        return {};

      case "stepIn":
        this.fireAndForget("t");
        return {};

      case "stepOut":
        this.fireAndForget("gu");
        return {};

      case "pause":
        // cdb interrupts on Ctrl+Break; on Windows the equivalent is
        // generating CTRL_BREAK_EVENT for the process group. From a
        // sibling Node process that means SIGBREAK to the cdb child.
        if (this.child) {
          try {
            this.child.kill("SIGBREAK" as NodeJS.Signals);
          } catch {
            /* fallthrough to no-op */
          }
        }
        return {};

      case "setBreakpoints": {
        const bpArgs = args as DebugProtocol.SetBreakpointsArguments;
        const file = bpArgs.source.path ?? bpArgs.source.name ?? "";
        // Clear existing line breakpoints in this file before setting
        // new ones; cdb does not have a "replace" idiom natively.
        await this.send("bc *");
        const breakpoints: DebugProtocol.Breakpoint[] = [];
        for (const bp of bpArgs.breakpoints ?? []) {
          // cdb syntax: bp `module!file:line`. We let cdb pick the
          // module by passing `\`file:line\``. Backticks are required.
          const cmd = `bp \`${file}:${bp.line}\``;
          const out = await this.send(cmd);
          const verified = !/Couldn't|Bp expression/i.test(out);
          breakpoints.push({
            verified,
            line: bp.line,
            source: bpArgs.source,
            message: verified ? undefined : out.trim() || "cdb rejected breakpoint",
          });
        }
        return { breakpoints };
      }

      case "setExceptionBreakpoints":
        // cdb has its own model (`sxe`/`sxd`); we accept the request
        // but do not configure anything yet — first-chance exceptions
        // already break by default.
        return {};

      case "loadedSources":
        return { sources: [] };

      default:
        throw new Error(
          `mythos-cpp (cdb backend): '${command}' is not implemented yet — see issue mythosdbg#1.`,
        );
    }
  }

  async dispose(): Promise<void> {
    if (!this.child) return;
    try {
      // Send `q` (quit). Don't await indefinitely — we kill the
      // child explicitly below if it does not exit cleanly.
      this.fireAndForget("q");
    } catch {
      /* ignore */
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

  /* ---------------- discovery ---------------- */

  private async resolveAdapter(): Promise<string> {
    const explicit = this.config.debugAdapter as string | undefined;
    if (explicit && explicit.length > 0) return explicit;

    // 1. PATH
    const where = spawnSync("where", ["cdb.exe"], { encoding: "utf8" });
    if (where.status === 0 && where.stdout.trim()) {
      return where.stdout.split(/\r?\n/)[0].trim();
    }

    // 2. Well-known Windows SDK install locations.
    const candidates = wellKnownCdbPaths();
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    throw new Error(
      [
        "Could not locate cdb.exe.",
        "Install the Windows SDK Debugging Tools (https://learn.microsoft.com/windows-hardware/drivers/debugger/),",
        `or set "debugAdapter" in launch.json. Searched: ${candidates.join(", ")}`,
      ].join(" "),
    );
  }

  private buildSpawnArgs(): string[] {
    const args: string[] = [];
    if (this.config.request === "attach") {
      const rawPid = this.config.processId;
      if (typeof rawPid !== "number" || !Number.isFinite(rawPid) || rawPid <= 0) {
        throw new Error(
          "mythos-cpp attach on Windows requires a numeric `processId`. " +
            "Process-name discovery is tracked in mythosdbg#3 (JIT-attach).",
        );
      }
      args.push("-p", String(rawPid));
    } else {
      const program = this.config.program as string | undefined;
      if (!program) {
        throw new Error("mythos-cpp launch on Windows requires `program`.");
      }
      // `-G` skips the final breakpoint cdb otherwise sets when the
      // program exits — without it the user has to type `g` once
      // more after their program returns from `main`.
      args.push("-G");
      args.push(program);
      const programArgs = (this.config.args as string[] | undefined) ?? [];
      args.push(...programArgs);
    }
    return args;
  }

  /* ---------------- command queue ---------------- */

  /**
   * Enqueue a cdb command. Resolves with the captured stdout output
   * up to but not including the sync-nonce echo line.
   */
  private send(command: string): Promise<string> {
    if (!this.child) return Promise.reject(new Error("cdb is not running"));
    const nonce = makeNonce();
    return new Promise<string>((resolve, reject) => {
      const entry: PendingCommand = {
        resolve,
        reject,
        command,
        nonce,
        buffer: [],
      };
      this.queue.push(entry);
      this.pumpQueue();
    });
  }

  /** Issue a command without waiting for its output (e.g. `g`, `q`). */
  private fireAndForget(command: string): void {
    if (!this.child) return;
    // No nonce — just write the command. The stop-event watcher
    // will pick up whatever cdb prints.
    this.child.stdin?.write(`${command}\r\n`);
  }

  private pumpQueue(): void {
    if (this.currentCommand || this.queue.length === 0 || !this.child) return;
    const next = this.queue.shift()!;
    this.currentCommand = next;
    this.child.stdin?.write(`${next.command}\r\n.echo ${next.nonce}\r\n`);
  }

  private feed(chunk: Buffer): void {
    this.lineBuf += chunk.toString("utf8");
    let nl: number;
    while ((nl = this.lineBuf.indexOf("\n")) >= 0) {
      const line = this.lineBuf.slice(0, nl).replace(/\r$/, "");
      this.lineBuf = this.lineBuf.slice(nl + 1);
      this.consumeLine(line);
    }
  }

  /** Exposed for tests — feed a single already-trimmed line. */
  consumeLine(line: string): void {
    // 1. Sync-nonce match — completes the in-flight command.
    if (this.currentCommand && line.trim() === this.currentCommand.nonce) {
      const out = this.currentCommand.buffer.join("\n");
      this.currentCommand.resolve(out);
      this.currentCommand = null;
      this.pumpQueue();
      return;
    }
    // 2. Stop-event detection.
    const stop = detectStop(line);
    if (stop) {
      // cdb does not always tell us which thread; default to the
      // current one.
      const threadId = stop.kind === "exception" || stop.kind === "breakpoint"
        ? stop.threadId
        : this.currentThreadId;
      this.emit?.({
        seq: 0,
        type: "event",
        event: "stopped",
        body: {
          reason: stopKindToDap(stop.kind),
          threadId,
          allThreadsStopped: true,
          description: "description" in stop ? stop.description : undefined,
        },
      } as DebugProtocol.StoppedEvent);
    }
    // 3. Track the active thread when cdb prints a prompt.
    const promptMatch = /^(\d+):(\d+)>/.exec(line);
    if (promptMatch) {
      this.currentThreadId = Number(promptMatch[1]);
    }
    // 4. Buffer for the in-flight command.
    if (this.currentCommand) {
      // Skip pure prompt lines — they pollute the captured output.
      if (!CDB_PROMPT.test(line)) {
        this.currentCommand.buffer.push(line);
      }
    } else if (line.trim().length > 0 && !CDB_PROMPT.test(line)) {
      // Out-of-band output (program stdout, async diagnostics) — ship
      // it as a DAP `output` event so users see it.
      this.emit?.({
        seq: 0,
        type: "event",
        event: "output",
        body: { category: "stdout", output: `${line}\n` },
      } as DebugProtocol.OutputEvent);
    }
  }

  private failPending(reason: string): void {
    if (this.currentCommand) {
      this.currentCommand.reject(new Error(reason));
      this.currentCommand = null;
    }
    while (this.queue.length > 0) {
      this.queue.shift()!.reject(new Error(reason));
    }
  }
}

/* -------------------- helpers (exported for tests) -------------------- */

export function wellKnownCdbPaths(): string[] {
  const out: string[] = [];
  const pf86 = process.env["ProgramFiles(x86)"];
  const pf = process.env.ProgramFiles;
  for (const root of [pf86, pf].filter(Boolean) as string[]) {
    out.push(path.join(root, "Windows Kits", "10", "Debuggers", "x64", "cdb.exe"));
    out.push(path.join(root, "Windows Kits", "10", "Debuggers", "x86", "cdb.exe"));
    out.push(path.join(root, "Windows Kits", "11", "Debuggers", "x64", "cdb.exe"));
  }
  return out;
}

export function parseThreads(output: string): DebugProtocol.Thread[] {
  // `~` output looks like:
  //    .  0  Id: e8c.13a4 Suspend: 1 Teb: 7ff... Unfrozen
  //       1  Id: e8c.b40  Suspend: 1 Teb: 7ff... Unfrozen
  const threads: DebugProtocol.Thread[] = [];
  for (const raw of output.split("\n")) {
    const m = /^\s*\.?\s*(\d+)\s+Id:\s*([0-9a-f.]+)/i.exec(raw);
    if (!m) continue;
    const id = Number(m[1]);
    threads.push({ id, name: `Thread ${m[2]}` });
  }
  return threads;
}

export function parseStack(output: string): DebugProtocol.StackFrame[] {
  // `kn` output:
  //   # ChildEBP RetAddr  Args to Child            file:line
  //   00 00abf8c0 7c81ca40 00000000 00000000 00000000 hello!main+0x1f [c:\src\hello\hello.c @ 12]
  const out: DebugProtocol.StackFrame[] = [];
  for (const raw of output.split("\n")) {
    const m = /^\s*([0-9a-f]+)\s+[0-9a-f]+\s+[0-9a-f]+(?:\s+[0-9a-f]+){0,4}\s+(\S+!\S+)(?:\s+\[(.+?)\s+@\s+(\d+)\])?/i.exec(
      raw,
    );
    if (!m) continue;
    const id = parseInt(m[1], 16);
    out.push({
      id,
      name: m[2],
      line: m[4] ? Number(m[4]) : 0,
      column: 0,
      source: m[3] ? { path: m[3], name: path.basename(m[3]) } : undefined,
    });
  }
  return out;
}

export function parseLocals(output: string): DebugProtocol.Variable[] {
  // `dv /v /t` output:
  //    00abf8b8         int counter = 0n42
  //    00abf8bc         char *argv = 0x00abfb20 "hello.exe"
  // The trailing identifier in the declaration is the variable name.
  // We strip any leading punctuation (e.g. `*` for pointers) so the
  // DAP `name` field is just the C identifier.
  const out: DebugProtocol.Variable[] = [];
  for (const raw of output.split("\n")) {
    const m = /^\s*[0-9a-f]+\s+(?:Type\s+)?(.+?)\s*=\s*(.+)$/i.exec(raw);
    if (!m) continue;
    const decl = m[1].trim();
    const value = m[2].trim();
    const declMatch = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(decl);
    if (!declMatch) continue;
    const name = declMatch[1];
    out.push({
      name,
      value,
      variablesReference: 0,
      type: decl.slice(0, decl.length - declMatch[0].length).trim(),
    });
  }
  return out;
}

export function parseEvaluate(output: string): string {
  // `?? expr` output looks like:
  //   int 0n42
  //   class std::vector<int> { size=3, capacity=4, ... }
  // We just return the trimmed payload.
  return output.replace(/^\s+|\s+$/g, "");
}

export function detectStop(line: string): StopReason | null {
  if (/^Breakpoint\s+\d+\s+hit/i.test(line)) {
    return { kind: "breakpoint", threadId: 0, description: line.trim() };
  }
  // cdb's first/second-chance exception lines look like:
  //   `(0e8c.13a4): Access violation - code c0000005 (first chance)`
  //   `(0e8c.13a4): C++ EH exception - code e06d7363 (first chance)`
  // The reliable signal is `(pid.tid): <text> - code <hex>`.
  if (/^\(\w+\.\w+\):\s+.*\bcode\s+[0-9a-f]+/i.test(line)) {
    return { kind: "exception", threadId: 0, description: line.trim() };
  }
  if (/^ModLoad:/.test(line)) return null; // benign
  return null;
}

function stopKindToDap(kind: StopReason["kind"]): string {
  switch (kind) {
    case "breakpoint": return "breakpoint";
    case "step":       return "step";
    case "exception":  return "exception";
    case "entry":      return "entry";
  }
}

/**
 * Encode a stack-frame id into a `variablesReference` so the
 * `variables` request can recover which frame was asked about. We
 * reserve the high bit (>= 0x40000000) for frame refs to avoid
 * colliding with future per-variable handles.
 */
function encodeFrameRef(frameId: number): number {
  return 0x40000000 | (frameId & 0x3fffffff);
}

function decodeFrameRef(ref: number): number | null {
  if ((ref & 0x40000000) === 0) return null;
  return ref & 0x3fffffff;
}

function makeNonce(): string {
  let s = "MYNX_";
  for (let i = s.length; i < NONCE_LENGTH; i++) {
    s += Math.floor(Math.random() * 16).toString(16);
  }
  return s;
}
