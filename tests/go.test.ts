import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { GoRuntime } from "../src/runtimes/go";

/**
 * GoRuntime is a thin wrapper over `dlv dap`. The end-to-end test is
 * skipped on hosts without Delve installed; the failure path
 * (no adapter discoverable) is exercised unconditionally.
 */
function dlvAvailable(): boolean {
  const w = spawnSync("/usr/bin/env", ["which", "dlv"], { encoding: "utf8" });
  return w.status === 0 && w.stdout.trim().length > 0;
}

describe("GoRuntime", () => {
  it("rejects start when dlv cannot be located", async () => {
    const r = new GoRuntime({
      type: "mythos-go",
      request: "launch",
      name: "test",
      // Pin debugAdapter to a path that does not exist so we deterministically
      // fail at spawn time instead of accidentally finding a system dlv.
      debugAdapter: "/definitely/not/a/path/to/dlv",
    });
    await expect(r.start(() => undefined)).rejects.toBeDefined();
  });

  it.skipIf(!dlvAvailable())(
    "spawns dlv dap and forwards a launch request (placeholder; expanded with full E2E)",
    () => {
      // Real Go end-to-end (compile a tiny .go, hit a breakpoint) is
      // not wired up yet; we keep the slot warm for CI on hosts that
      // ship dlv. Tracked alongside the cppLldb harness story.
    },
  );
});
