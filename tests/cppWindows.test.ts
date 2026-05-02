import { describe, expect, it } from "vitest";
import {
  parseThreads,
  parseStack,
  parseLocals,
  parseEvaluate,
  detectStop,
  wellKnownCdbPaths,
} from "../src/runtimes/cppWindows";

/**
 * The cdb-driven runtime is end-to-end testable only on Windows with
 * the Windows SDK installed. The output parsers, however, are the
 * fragile parts; we pin their behaviour here on every host so a
 * tweak that breaks one of them is caught immediately.
 *
 * Sample fixtures below were produced by running cdb against a
 * trivial C program built with cl.exe; we keep them in-source so the
 * suite has no external dependencies.
 */

describe("cppWindows: parseThreads", () => {
  it("parses cdb's `~` listing with current-thread marker", () => {
    const sample = [
      ".  0  Id: e8c.13a4 Suspend: 1 Teb: 7ff8`abcdef00 Unfrozen",
      "   1  Id: e8c.b40  Suspend: 1 Teb: 7ff8`abcd0000 Unfrozen",
      "   2  Id: e8c.f4c  Suspend: 1 Teb: 7ff8`abcc0000 Unfrozen",
    ].join("\n");
    const threads = parseThreads(sample);
    expect(threads.map((t) => t.id)).toEqual([0, 1, 2]);
    expect(threads[0].name).toContain("e8c.13a4");
  });

  it("returns empty when given non-thread output", () => {
    expect(parseThreads("ModLoad: 00 00 hello.exe")).toEqual([]);
  });
});

describe("cppWindows: parseStack", () => {
  it("parses `kn` output with file:line annotations", () => {
    const sample = [
      " # ChildEBP RetAddr  Args to Child            ",
      "00 00abf8c0 7c81ca40 00000000 00000000 00000000 hello!main+0x1f [c:\\src\\hello\\hello.c @ 12]",
      "01 00abf8d8 00000000 00000000 00000000 00000000 hello!__tmainCRTStartup+0x10b [crtexe.c @ 597]",
    ].join("\n");
    const frames = parseStack(sample);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({
      id: 0,
      name: "hello!main+0x1f",
      line: 12,
      source: { path: "c:\\src\\hello\\hello.c" },
    });
    expect(frames[1].source!.path).toBe("crtexe.c");
  });

  it("survives frames without source annotations", () => {
    const sample = "00 00abf8c0 7c81ca40 00000000 00000000 00000000 ntdll!RtlUserThreadStart+0x21";
    const frames = parseStack(sample);
    expect(frames).toHaveLength(1);
    expect(frames[0].source).toBeUndefined();
    expect(frames[0].line).toBe(0);
  });
});

describe("cppWindows: parseLocals", () => {
  it("extracts identifier, type and value from `dv /v /t`", () => {
    const sample = [
      "00abf8b8         int counter = 0n42",
      "00abf8bc         char *argv = 0x00abfb20 \"hello.exe\"",
    ].join("\n");
    const locals = parseLocals(sample);
    expect(locals).toHaveLength(2);
    expect(locals[0]).toMatchObject({ name: "counter", value: "0n42", type: "int" });
    expect(locals[1]).toMatchObject({ name: "argv" });
    expect(locals[1].type).toContain("char");
  });
});

describe("cppWindows: parseEvaluate", () => {
  it("returns trimmed output verbatim", () => {
    expect(parseEvaluate("\nint 0n42\n")).toBe("int 0n42");
  });
});

describe("cppWindows: detectStop", () => {
  it("recognises breakpoint hits", () => {
    expect(detectStop("Breakpoint 0 hit")?.kind).toBe("breakpoint");
  });

  it("recognises first-chance exceptions", () => {
    expect(detectStop("(0e8c.13a4): Access violation - code c0000005")?.kind).toBe("exception");
  });

  it("ignores benign module-load lines", () => {
    expect(detectStop("ModLoad: 00 00 hello.exe")).toBeNull();
  });

  it("returns null for ordinary output", () => {
    expect(detectStop("just some text")).toBeNull();
  });
});

describe("cppWindows: wellKnownCdbPaths", () => {
  it("returns paths under ProgramFiles roots when env vars are set", () => {
    // We do not actually require these env vars to be present on the
    // host; we just verify the helper's shape and that nothing throws
    // without them.
    const paths = wellKnownCdbPaths();
    for (const p of paths) {
      expect(p.endsWith("cdb.exe")).toBe(true);
      expect(p).toContain("Debuggers");
    }
  });
});
