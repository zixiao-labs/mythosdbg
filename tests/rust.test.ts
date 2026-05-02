import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { RustRuntime, parseCargoSourceMap } from "../src/runtimes/rust";

/**
 * RustRuntime layers Rust-specific niceties (pretty-printers, cargo
 * source-map ingest) on top of the same lldb-dap proxy as cppLldb.
 * The end-to-end test is skipped on hosts without lldb-dap; the
 * cargo source-map parser is exercised unconditionally.
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

describe("RustRuntime", () => {
  it("rejects start when lldb-dap cannot be located", async () => {
    const r = new RustRuntime({
      type: "mythos-rust",
      request: "launch",
      name: "test",
      debugAdapter: "/definitely/not/a/path/to/lldb-dap",
    });
    await expect(r.start(() => undefined)).rejects.toBeDefined();
  });

  it.skipIf(!lldbDapAvailable())(
    "spawns lldb-dap and forwards a launch request (placeholder; expanded with full E2E)",
    () => {
      // Real Rust end-to-end (cargo build a tiny crate, hit a
      // breakpoint on `Vec` to confirm the pretty-printer fires) is
      // not wired up yet. Tracked alongside the cppLldb harness story.
    },
  );
});

describe("parseCargoSourceMap", () => {
  it("returns null when the file has no [source-map] table", () => {
    const toml = `
      [build]
      target = "x86_64-unknown-linux-gnu"
    `;
    expect(parseCargoSourceMap(toml)).toBeNull();
  });

  it("parses a [source-map] table into a flat map", () => {
    const toml = `
      [source-map]
      "/build/myproject" = "/Users/me/code/myproject"
      "/rustc/abc1234"   = "/usr/local/lib/rustlib/src/rust"
    `;
    const map = parseCargoSourceMap(toml);
    expect(map).toEqual({
      "/build/myproject": "/Users/me/code/myproject",
      "/rustc/abc1234": "/usr/local/lib/rustlib/src/rust",
    });
  });

  it("ignores comments and unrelated tables", () => {
    const toml = `
      # comment-only line
      [build]
      target = "x86_64-unknown-linux-gnu"

      [source-map]   # rewrite container paths to host paths
      "/work" = "/Users/me/work"

      [env]
      RUSTFLAGS = "--cfg test"
    `;
    expect(parseCargoSourceMap(toml)).toEqual({ "/work": "/Users/me/work" });
  });
});
