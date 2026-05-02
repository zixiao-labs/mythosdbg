import { MythosSession } from "./core/mythosSession.js";
import { EchoRuntime } from "./runtimes/echo.js";
import { CppLldbRuntime } from "./runtimes/cppLldb.js";
import { LuaRuntime } from "./runtimes/lua.js";
import type { LaunchArguments, Runtime } from "./core/runtime.js";

/**
 * Mythos DAP server entry point. Picks the runtime by the launch
 * config's `type` field and hands off to MythosSession.
 *
 *   - `mythos-echo` → EchoRuntime (built-in self-test)
 *   - `mythos-cpp`  → CppLldbRuntime (lldb-dap wrapper, prototype)
 *   - `mythos-lua`  → LuaRuntime (actboy168/lua-debug wrapper)
 *
 * Anything else throws on `launch`. New runtime types are added in
 * `runtimes/` and registered in `runtimeFactory` here.
 */
function runtimeFactory(config: LaunchArguments): Runtime {
  switch (config.type) {
    case "mythos-echo":
      return new EchoRuntime(config);
    case "mythos-cpp":
      return new CppLldbRuntime(config);
    case "mythos-lua":
      return new LuaRuntime(config);
    default:
      throw new Error(`mythosdbg: unsupported launch type '${config.type}'`);
  }
}

const session = new MythosSession(runtimeFactory);
session.start(process.stdin, process.stdout);
