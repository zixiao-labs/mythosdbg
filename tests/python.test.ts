import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { PythonRuntime } from "../src/runtimes/python";

/**
 * PythonRuntime is a thin wrapper over `python -m debugpy.adapter`. The
 * test detects whether a Python interpreter with debugpy is available;
 * if not, the end-to-end placeholder is skipped (matches the
 * cppLldb.test.ts pattern).
 *
 * The synchronous interpreter-resolution and importability checks are
 * exercised unconditionally — they are the parts users hit first when
 * something is misconfigured.
 */
function pythonWithDebugpy(): string | null {
  for (const candidate of ["python3", "python"]) {
    const which = spawnSync("/usr/bin/env", ["which", candidate], {
      encoding: "utf8",
    });
    if (which.status !== 0 || !which.stdout.trim()) continue;
    const probe = spawnSync(which.stdout.trim(), ["-c", "import debugpy"], {
      encoding: "utf8",
    });
    if (probe.status === 0) return which.stdout.trim();
  }
  return null;
}

describe("PythonRuntime", () => {
  it("rejects start when no python is on PATH and config.python is missing", async () => {
    const r = new PythonRuntime({
      type: "mythos-python",
      request: "launch",
      name: "test",
      python: "/definitely/not/a/path/to/python",
    });
    await expect(r.start(() => undefined)).rejects.toThrow(/cannot import debugpy|ENOENT|spawn/);
  });

  it.skipIf(!pythonWithDebugpy())(
    "spawns debugpy and forwards a launch request (placeholder; expanded with full E2E)",
    () => {
      // Real Python end-to-end (run a tiny .py, hit a breakpoint) is
      // not wired up yet; we keep the slot warm for CI on hosts that
      // ship debugpy. Tracked alongside the cppLldb harness story.
    },
  );
});
