import { describe, expect, it } from "vitest";
import {
  parsePosixPs,
  parseWindowsTasklist,
  resolveAttachPid,
  findProcesses,
} from "../src/core/processes";

describe("parsePosixPs", () => {
  it("parses well-formed `ps -eo pid=,user=,comm=,args=` output", () => {
    const sample = [
      "    1 root             /sbin/launchd     /sbin/launchd",
      "  421 logos            node              /usr/bin/node /opt/app/server.js --port 8080",
      " 9999 logos            mythosdbg         node /opt/mythos/dist/server.js",
      "",
    ].join("\n");
    const procs = parsePosixPs(sample);
    expect(procs.map((p) => p.pid)).toEqual([1, 421, 9999]);
    expect(procs[1].name).toBe("node");
    expect(procs[1].command).toContain("server.js");
    expect(procs[1].user).toBe("logos");
  });

  it("strips path components from the comm column", () => {
    const sample = "  77 ci /usr/local/bin/dlv /usr/local/bin/dlv dap";
    const [p] = parsePosixPs(sample);
    expect(p.name).toBe("dlv");
    expect(p.command).toBe("/usr/local/bin/dlv dap");
  });

  it("ignores blank and malformed lines", () => {
    const sample = ["", "not a process line at all", "  42 user comm args here"].join("\n");
    const procs = parsePosixPs(sample);
    expect(procs).toHaveLength(1);
    expect(procs[0].pid).toBe(42);
  });
});

describe("parseWindowsTasklist", () => {
  it("parses `tasklist /FO CSV /NH` lines", () => {
    const sample = [
      '"System Idle Process","0","Services","0","8 K"',
      '"node.exe","12345","Console","1","45,123 K"',
      '"my,process.exe","678","Console","1","100 K"',
      "",
    ].join("\r\n");
    const procs = parseWindowsTasklist(sample);
    expect(procs.map((p) => p.pid)).toEqual([0, 12345, 678]);
    expect(procs[1].name).toBe("node.exe");
    // Embedded comma in the image name should be preserved.
    expect(procs[2].name).toBe("my,process.exe");
  });
});

describe("resolveAttachPid", () => {
  it("returns the explicit PID when it exists (we are alive)", () => {
    expect(resolveAttachPid({ processId: process.pid })).toBe(process.pid);
  });

  it("rejects negative or non-numeric PIDs", () => {
    expect(() => resolveAttachPid({ processId: -1 })).toThrow(/Invalid processId/);
    expect(() => resolveAttachPid({ processId: Number.NaN })).toThrow(/Invalid processId/);
  });

  it("requires either processId or processName", () => {
    expect(() => resolveAttachPid({})).toThrow(/processId or processName/);
  });

  it("rejects PIDs that don't exist on POSIX", () => {
    if (process.platform === "win32") return;
    // PID 0xFFFFF is reliably free on every modern POSIX kernel.
    expect(() => resolveAttachPid({ processId: 0xfffff })).toThrow(/Cannot attach/);
  });
});

describe("findProcesses (live)", () => {
  it("can locate the current Node process by PID", () => {
    if (process.platform === "win32") return; // tasklist may be slow in CI; PID-only path is enough
    const found = findProcesses({ pid: process.pid });
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found[0].pid).toBe(process.pid);
  });
});
