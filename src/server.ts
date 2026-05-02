import { MythosSession, type MythosCapabilities } from "./core/mythosSession.js";
import { EchoRuntime } from "./runtimes/echo.js";
import { CppLldbRuntime } from "./runtimes/cppLldb.js";
import { CppCdbRuntime } from "./runtimes/cppWindows.js";
import { createRequire } from "node:module";
import type { LaunchArguments, Runtime } from "./core/runtime.js";

/**
 * Mythos DAP server entry point. Picks the runtime by the launch
 * config's `type` field and hands off to MythosSession.
 *
 *   - `mythos-echo` → EchoRuntime (built-in self-test)
 *   - `mythos-cpp`  → CppLldbRuntime on POSIX, CppCdbRuntime on Windows
 *
 * Anything else throws on `launch`. New runtime types are added in
 * `runtimes/` and registered in `runtimeFactory` here.
 */
function runtimeFactory(config: LaunchArguments): Runtime {
  switch (config.type) {
    case "mythos-echo":
      return new EchoRuntime(config);
    case "mythos-cpp":
      return process.platform === "win32"
        ? new CppCdbRuntime(config)
        : new CppLldbRuntime(config);
    default:
      throw new Error(`mythosdbg: unsupported launch type '${config.type}'`);
  }
}

const SUPPORTED_TYPES = ["mythos-echo", "mythos-cpp"] as const;

/**
 * Read `package.json#version` once at startup so the version we
 * advertise to Logos is the one we actually shipped, not a guess.
 */
function readMythosVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
  } catch {
    /* ignore — fallthrough to "0.0.0" */
  }
  return "0.0.0";
}

const capabilities: MythosCapabilities = {
  mythosVersion: readMythosVersion(),
  schemaVersion: 1,
  minimumLogosVersion: "1.2.0",
  supportedTypes: [...SUPPORTED_TYPES],
  features: {
    attach: false,
    remote: false,
  },
};

const session = new MythosSession(runtimeFactory, { capabilities });
session.start(process.stdin, process.stdout);
