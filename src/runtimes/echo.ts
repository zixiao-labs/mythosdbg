import type { DebugProtocol } from "@vscode/debugprotocol";
import type { Runtime, LaunchArguments } from "../core/runtime";

/**
 * Echo runtime — exists purely as a self-test. It accepts launch,
 * synthetically reports a single thread that is already "stopped"
 * with reason "entry", and replies to every other request with the
 * smallest legal DAP body. Used by `tests/echo.test.ts` to verify
 * the framing + dispatch loop without any real debugger.
 *
 * Anything that needs more than this (real C/C++ debugging, source
 * mapping, etc.) is handled in `runtimes/cppLldb.ts` or future
 * runtimes — not here.
 */
export class EchoRuntime implements Runtime {
  readonly id = "echo";
  private emit: ((evt: DebugProtocol.Event) => void) | null = null;
  private readonly threadId = 1;

  constructor(private readonly _config: LaunchArguments) {
    void this._config;
  }

  async start(emit: (evt: DebugProtocol.Event) => void): Promise<void> {
    this.emit = emit;
    queueMicrotask(() => {
      this.emit?.({
        seq: 0,
        type: "event",
        event: "stopped",
        body: {
          reason: "entry",
          threadId: this.threadId,
          allThreadsStopped: true,
        },
      } as DebugProtocol.StoppedEvent);
    });
  }

  async handle(command: string, _args: unknown): Promise<unknown> {
    switch (command) {
      case "configurationDone":
        return {};
      case "threads":
        return { threads: [{ id: this.threadId, name: "echo-main" }] };
      case "stackTrace":
        return {
          stackFrames: [
            {
              id: 1,
              name: "echo()",
              line: 1,
              column: 1,
            },
          ],
          totalFrames: 1,
        };
      case "scopes":
        return { scopes: [] };
      case "variables":
        return { variables: [] };
      case "continue":
        this.emit?.({
          seq: 0,
          type: "event",
          event: "continued",
          body: {
            threadId: this.threadId,
            allThreadsContinued: true,
          },
        } as DebugProtocol.ContinuedEvent);
        queueMicrotask(() => {
          this.emit?.({
            seq: 0,
            type: "event",
            event: "terminated",
          } as DebugProtocol.TerminatedEvent);
        });
        return { allThreadsContinued: true };
      case "evaluate":
        return { result: "echo", variablesReference: 0 };
      case "setBreakpoints":
        return { breakpoints: [] };
      case "setExceptionBreakpoints":
        return {};
      case "loadedSources":
        return { sources: [] };
      default:
        return {};
    }
  }

  async dispose(): Promise<void> {
    this.emit = null;
  }
}
