import { spawnSync } from "node:child_process";
import { describe, it } from "vitest";

/**
 * cppLldb runtime is a thin wrapper over `lldb-dap` (LLVM 18+). The
 * test detects whether `lldb-dap` is on PATH (via `xcrun --find` on
 * macOS, or `which`) and skips otherwise — there's no point asserting
 * lldb behavior on a CI runner without LLVM.
 *
 * When lldb-dap *is* present, this test will be expanded to spawn
 * mythosdbg with a tiny "hello world" C program (built with cc) and
 * verify a single launch + breakpoint + step sequence. That work is
 * tracked as a follow-up issue (mythosdbg#1: end-to-end C/C++ test
 * harness). For now the body just no-ops — we ship the prototype
 * runtime in v0.0.0 and grow this test alongside it.
 */
function lldbDapAvailable(): boolean {
  if (process.platform === "darwin") {
    const r = spawnSync("/usr/bin/xcrun", ["--find", "lldb-dap"], {
      encoding: "utf8",
    });
    if (r.status === 0 && r.stdout.trim()) return true;
  }
  const w = spawnSync("/usr/bin/env", ["which", "lldb-dap"], {
    encoding: "utf8",
  });
  return w.status === 0 && w.stdout.trim().length > 0;
}

describe("CppLldbRuntime", () => {
  it.skipIf(!lldbDapAvailable())(
    "spawns lldb-dap and forwards a launch request (placeholder; see mythosdbg#1)",
    () => {
      // Real C/C++ end-to-end test is not yet implemented. The
      // runtime is exercised by hand via Logos's mythos-cpp launch
      // type. We keep this test slot warm so CI on macOS reminds
      // us when lldb-dap goes missing.
    },
  );
});
