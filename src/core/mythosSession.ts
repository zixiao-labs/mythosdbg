import { LoggingDebugSession, OutputEvent, TerminatedEvent } from "@vscode/debugadapter";
import type { DebugProtocol } from "@vscode/debugprotocol";
import type { Runtime, LaunchArguments } from "./runtime";

/**
 * MythosSession is the top-level DAP session that delegates every
 * request body to a per-language `Runtime` chosen at `launch` time.
 *
 * The session itself stays generic: it speaks DAP, hands DAP
 * arguments through to the runtime, and turns runtime errors into
 * unsuccessful DAP responses. Anything language-specific
 * (lldb, gdb, debugpy, etc.) belongs in the Runtime.
 *
 * The dispatch table here only covers the requests we know the
 * `echo` and `cppLldb` runtimes support today; new requests are
 * added by listing them in `requestsRoutedToRuntime` so we don't
 * accidentally swallow new DAP commands without thought.
 */

const requestsRoutedToRuntime: ReadonlySet<string> = new Set<string>([
  "configurationDone",
  "threads",
  "stackTrace",
  "scopes",
  "variables",
  "setVariable",
  "evaluate",
  "continue",
  "next",
  "stepIn",
  "stepOut",
  "pause",
  "restart",
  "setBreakpoints",
  "setFunctionBreakpoints",
  "setExceptionBreakpoints",
  "source",
  "loadedSources",
  "completions",
  "exceptionInfo",
  "modules",
  "readMemory",
  "writeMemory",
  "disassemble",
  "terminateThreads",
]);

export type RuntimeFactory = (config: LaunchArguments) => Promise<Runtime> | Runtime;

export class MythosSession extends LoggingDebugSession {
  private runtime: Runtime | null = null;
  private readonly runtimeFactory: RuntimeFactory;

  constructor(runtimeFactory: RuntimeFactory) {
    super("mythosdbg.log");
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);
    this.runtimeFactory = runtimeFactory;
  }

  protected initializeRequest(
    response: DebugProtocol.InitializeResponse,
    _args: DebugProtocol.InitializeRequestArguments,
  ): void {
    response.body = response.body ?? {};
    Object.assign(response.body, {
      supportsConfigurationDoneRequest: true,
      supportsEvaluateForHovers: true,
      supportsStepBack: false,
      supportsSetVariable: true,
      supportsRestartRequest: true,
      supportsExceptionInfoRequest: true,
      supportsCompletionsRequest: false,
      supportsLoadedSourcesRequest: true,
      supportsTerminateRequest: true,
      supportsConditionalBreakpoints: true,
      supportsHitConditionalBreakpoints: true,
      supportsLogPoints: true,
      supportsModulesRequest: true,
      supportsReadMemoryRequest: true,
      supportsWriteMemoryRequest: false,
      supportsDisassembleRequest: false,
    });
    this.sendResponse(response);
    this.sendEvent({ event: "initialized", type: "event" } as DebugProtocol.InitializedEvent);
  }

  protected async launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: DebugProtocol.LaunchRequestArguments,
  ): Promise<void> {
    try {
      const config = args as unknown as LaunchArguments;
      this.runtime = await this.runtimeFactory(config);
      await this.runtime.start((evt) => this.sendEvent(evt));
      this.sendResponse(response);
    } catch (err) {
      this.sendErrorResponse(response, 1001, this.formatError(err));
    }
  }

  protected async attachRequest(
    response: DebugProtocol.AttachResponse,
    args: DebugProtocol.AttachRequestArguments,
  ): Promise<void> {
    return this.launchRequest(response, args as DebugProtocol.LaunchRequestArguments);
  }

  protected async disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
    _args: DebugProtocol.DisconnectArguments,
  ): Promise<void> {
    try {
      await this.runtime?.dispose();
    } catch (err) {
      this.sendEvent(new OutputEvent(`runtime dispose failed: ${this.formatError(err)}\n`, "stderr"));
    } finally {
      this.runtime = null;
      this.sendResponse(response);
      this.sendEvent(new TerminatedEvent());
    }
  }

  protected async terminateRequest(
    response: DebugProtocol.TerminateResponse,
    _args: DebugProtocol.TerminateArguments,
  ): Promise<void> {
    return this.disconnectRequest(
      response as unknown as DebugProtocol.DisconnectResponse,
      {} as DebugProtocol.DisconnectArguments,
    );
  }

  /** Catch-all: dispatch any "supported" DAP request to the runtime. */
  protected async dispatchRequest(request: DebugProtocol.Request): Promise<void> {
    if (!requestsRoutedToRuntime.has(request.command)) {
      return super.dispatchRequest(request);
    }
    const response: DebugProtocol.Response = {
      seq: 0,
      type: "response",
      request_seq: request.seq,
      success: true,
      command: request.command,
    };
    if (!this.runtime) {
      this.sendErrorResponse(response, 1002, "No runtime — call launch first.");
      return;
    }
    try {
      const body = await this.runtime.handle(request.command, request.arguments);
      if (body !== undefined) {
        (response as DebugProtocol.Response & { body?: unknown }).body = body;
      }
      this.sendResponse(response);
    } catch (err) {
      this.sendErrorResponse(response, 1003, this.formatError(err));
    }
  }

  private formatError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
