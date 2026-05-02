import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { LuaRuntime } from "../src/runtimes/lua";

/**
 * LuaRuntime is a thin wrapper over actboy168/lua-debug. The
 * end-to-end test is skipped on hosts without lua-debug installed;
 * the failure path (no adapter discoverable) is exercised
 * unconditionally.
 */
function luaDebugAvailable(): boolean {
  const exe = process.platform === "win32" ? "lua-debug.exe" : "lua-debug";
  const w = process.platform === "win32"
    ? spawnSync("where", [exe], { encoding: "utf8" })
    : spawnSync("/usr/bin/env", ["which", exe], { encoding: "utf8" });
  return w.status === 0 && w.stdout.trim().length > 0;
}

describe("LuaRuntime", () => {
  it("rejects start when lua-debug cannot be located", async () => {
    const r = new LuaRuntime({
      type: "mythos-lua",
      request: "launch",
      name: "test",
      debugAdapter: "/definitely/not/a/path/to/lua-debug",
    });
    await expect(r.start(() => undefined)).rejects.toBeDefined();
  });

  it.skipIf(!luaDebugAvailable())(
    "spawns lua-debug and forwards a launch request (placeholder; expanded with full E2E)",
    () => {
      // Real Lua end-to-end (run a tiny .lua, hit a breakpoint) is not
      // wired up yet; we keep the slot warm for CI on hosts that ship
      // lua-debug. Tracked alongside the cppLldb harness story.
    },
  );
});
