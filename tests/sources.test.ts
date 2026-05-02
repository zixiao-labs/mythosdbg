import { describe, expect, it } from "vitest";
import type { DebugProtocol } from "@vscode/debugprotocol";
import { SourceResolver, buildResolverFromLaunchConfig } from "../src/core/sources";

/**
 * SourceResolver tests. We pass `fileExists` overrides so the suite
 * does not touch the real filesystem; that keeps the cases
 * deterministic on every host.
 */

describe("SourceResolver.rewriteSource", () => {
  it("returns the source untouched when no map is configured", () => {
    const resolver = new SourceResolver({ fileExists: () => true });
    const out = resolver.rewriteSource({ path: "/Users/me/main.c", name: "main.c" });
    expect(out.hit).toBe(true);
    expect(out.source.path).toBe("/Users/me/main.c");
    expect(out.source.sourceReference ?? 0).toBe(0);
  });

  it("rewrites longest-prefix-first and returns the host path when it exists", () => {
    const resolver = new SourceResolver({
      sourceMap: {
        "/build": "/host",
        "/build/myproj": "/Users/me/myproj",
      },
      fileExists: (p) => p === "/Users/me/myproj/src/main.c",
    });
    const out = resolver.rewriteSource({ path: "/build/myproj/src/main.c" });
    expect(out.hit).toBe(true);
    expect(out.source.path).toBe("/Users/me/myproj/src/main.c");
  });

  it("expands ${workspaceFolder} on both sides of the mapping", () => {
    const resolver = new SourceResolver({
      workspaceFolder: "/Users/me/work",
      sourceMap: { "/build": "${workspaceFolder}/checkout" },
      fileExists: (p) => p === "/Users/me/work/checkout/main.c",
    });
    const out = resolver.rewriteSource({ path: "/build/main.c" });
    expect(out.source.path).toBe("/Users/me/work/checkout/main.c");
  });

  it("emits a sourceReference and drops `path` when the host file does not exist", () => {
    const resolver = new SourceResolver({
      sourceMap: { "/build/myproj": "/Users/me/myproj" },
      fileExists: () => false,
    });
    const out = resolver.rewriteSource({ path: "/build/myproj/src/foo.c", name: "foo.c" });
    expect(out.hit).toBe(false);
    expect(out.source.path).toBeUndefined();
    expect(out.source.sourceReference).toBeGreaterThan(0);
    expect(out.source.name).toBe("foo.c");
    expect(out.source.adapterData).toEqual({
      originalPath: "/build/myproj/src/foo.c",
      rewrittenPath: "/Users/me/myproj/src/foo.c",
    });
  });

  it("synthesizes a sourceReference even when no rewrite matches but the file is missing", () => {
    const resolver = new SourceResolver({ fileExists: () => false });
    const out = resolver.rewriteSource({ path: "/build/strange.c" });
    expect(out.hit).toBe(false);
    expect(out.source.sourceReference).toBeGreaterThan(0);
  });

  it("returns null body for unknown references and a stub body for owned references", () => {
    const resolver = new SourceResolver({
      sourceMap: { "/build/myproj": "/host/myproj" },
      fileExists: () => false,
    });
    const out = resolver.rewriteSource({ path: "/build/myproj/foo.c" });
    const ref = out.source.sourceReference!;
    expect(resolver.ownsReference(ref)).toBe(true);
    const body = resolver.getBody(ref)!;
    expect(body.content).toContain("/build/myproj/foo.c");
    expect(body.content).toContain("/host/myproj/foo.c");
    expect(resolver.getBody(99999)).toBeNull();
  });
});

describe("SourceResolver.rewriteStackTraceBody", () => {
  it("rewrites every frame's source path", () => {
    const resolver = new SourceResolver({
      sourceMap: { "/build": "/host" },
      fileExists: (p) => p.startsWith("/host"),
    });
    const body: DebugProtocol.StackTraceResponse["body"] = {
      stackFrames: [
        { id: 1, name: "main", line: 10, column: 1, source: { path: "/build/main.c" } },
        { id: 2, name: "lib_call", line: 5, column: 1, source: { path: "/build/lib.c" } },
      ],
      totalFrames: 2,
    };
    const rewritten = resolver.rewriteStackTraceBody(body);
    expect(rewritten.stackFrames[0].source!.path).toBe("/host/main.c");
    expect(rewritten.stackFrames[1].source!.path).toBe("/host/lib.c");
    // Original body must not be mutated.
    expect(body.stackFrames[0].source!.path).toBe("/build/main.c");
  });
});

describe("buildResolverFromLaunchConfig", () => {
  it("plumbs sourceMap and symbolSearchPath through, expanding ${workspaceFolder}", () => {
    const resolver = buildResolverFromLaunchConfig(
      {
        type: "mythos-cpp",
        request: "launch",
        name: "x",
        sourceMap: { "/build": "${workspaceFolder}/checkout" },
        symbolSearchPath: ["${workspaceFolder}/sym"],
      } as unknown as Record<string, unknown> & {
        sourceMap: Record<string, string>;
        symbolSearchPath: string[];
      },
      "/Users/me/work",
      () => false,
    );
    expect(resolver.symbolSearchPath).toEqual(["/Users/me/work/sym"]);
    const out = resolver.rewriteSource({ path: "/build/main.c" });
    expect(out.source.adapterData).toMatchObject({
      rewrittenPath: "/Users/me/work/checkout/main.c",
    });
  });
});
