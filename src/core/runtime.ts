import type { DebugProtocol } from "@vscode/debugprotocol";

/**
 * A Mythos `Runtime` is the per-language adapter that knows how to
 * actually drive a debugger. It receives DAP-shaped requests from
 * the session router and is free to implement them by speaking to
 * lldb-dap, gdb-mi, debugpy, or its own protocol.
 *
 * For the v0.0 prototype the simplest possible Runtime is the `echo`
 * runtime under `src/runtimes/echo.ts` — it answers `initialize` and
 * `launch` synthetically and exits when asked to disconnect.
 *
 * A real Runtime should:
 *   - acquire the underlying debugger process in `start()`
 *   - translate each DAP request to the underlying debugger and
 *     return the response body
 *   - emit DAP events (`stopped`, `output`, etc.) via `emitEvent`
 *   - clean up its child processes / sockets in `dispose()`
 *
 * The runtime is not responsible for DAP framing — that's the
 * server entry point's job (`src/server.ts`). The runtime sees
 * already-decoded message bodies.
 */
export interface Runtime {
  readonly id: string;

  /** Called once after the session has been created, before any DAP
   *  request lands. Use it to warm up child processes if necessary. */
  start(emitEvent: (event: DebugProtocol.Event) => void): Promise<void>;

  /**
   * Handle a DAP request. Return the response body (or `undefined`
   * if there is no body for that command). Throw to produce an
   * unsuccessful DAP response.
   */
  handle(
    command: string,
    args: unknown,
  ): Promise<unknown>;

  /** Tear down everything (subprocess, sockets, timers). */
  dispose(): Promise<void>;
}

/** Args the launch.json passes through DAP `launch`. */
export type LaunchArguments = {
  type: string;
  request: "launch" | "attach";
  name: string;
  program?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  [k: string]: unknown;
};
