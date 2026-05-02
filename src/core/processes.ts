import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Process discovery for the `attach` flow. We deliberately keep this
 * dependency-free: `ps` on POSIX, `tasklist` on Windows. Each backend
 * returns the same `ProcessInfo` shape so the rest of the codebase
 * does not need platform branches.
 *
 * Mythos uses this in two places:
 *   1. The Logos UI surfaces a process picker when a user starts an
 *      attach session without `processId` set.
 *   2. Each runtime calls `findProcesses({ name })` to convert a
 *      user-supplied executable basename into a concrete PID before
 *      forwarding `attach` to the underlying debugger.
 */

export interface ProcessInfo {
  pid: number;
  /** Executable basename (no path, no args). */
  name: string;
  /** Full command line as the OS reports it. May be truncated on Windows. */
  command: string;
  /** Owning user, when available. */
  user?: string;
}

export interface FindProcessesQuery {
  /** Exact PID. When set, the helper still verifies the process exists. */
  pid?: number;
  /**
   * Executable basename or substring (case-insensitive) match against
   * `command`. When more than one process matches, the caller decides
   * how to disambiguate.
   */
  name?: string;
}

/**
 * Snapshot the running process list and return matches.
 *
 * Throws when the platform helper (`ps` / `tasklist`) is unavailable,
 * so callers can surface that as an actionable error in the UI.
 */
export function findProcesses(query: FindProcessesQuery = {}): ProcessInfo[] {
  const all = listProcesses();
  return all.filter((p) => matchesQuery(p, query));
}

export function listProcesses(): ProcessInfo[] {
  if (process.platform === "win32") return listProcessesWindows();
  return listProcessesPosix();
}

function matchesQuery(info: ProcessInfo, query: FindProcessesQuery): boolean {
  if (query.pid !== undefined && info.pid !== query.pid) return false;
  if (query.name !== undefined) {
    const needle = query.name.toLowerCase();
    if (
      !info.name.toLowerCase().includes(needle) &&
      !info.command.toLowerCase().includes(needle)
    ) {
      return false;
    }
  }
  return true;
}

function listProcessesPosix(): ProcessInfo[] {
  // `ps -eo pid=,user=,comm=,args=` is portable across macOS and Linux
  // (BSD `ps` and procps both accept it) and avoids locale-dependent
  // header parsing.
  const r = spawnSync("ps", ["-eo", "pid=,user=,comm=,args="], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`ps failed (exit ${r.status}): ${r.stderr.trim()}`);
  }
  return parsePosixPs(r.stdout);
}

/** Exported for unit tests — see tests/processes.test.ts. */
export function parsePosixPs(stdout: string): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    // PID USER COMM ARGS — COMM has no spaces, ARGS may have many.
    const m = /^(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isFinite(pid)) continue;
    out.push({
      pid,
      user: m[2],
      name: basenameOf(m[3]),
      command: m[4],
    });
  }
  return out;
}

function listProcessesWindows(): ProcessInfo[] {
  // /FO CSV gives us a stable, parseable format. /NH suppresses the
  // header row so we can split lines uniformly.
  const r = spawnSync("tasklist", ["/FO", "CSV", "/NH"], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`tasklist failed (exit ${r.status}): ${r.stderr.trim()}`);
  }
  return parseWindowsTasklist(r.stdout);
}

/** Exported for unit tests. */
export function parseWindowsTasklist(stdout: string): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    // `tasklist /FO CSV /NH` columns:
    //   "Image Name","PID","Session Name","Session#","Mem Usage"
    const cells = parseCsvLine(line);
    if (cells.length < 2) continue;
    const pid = Number(cells[1]);
    if (!Number.isFinite(pid)) continue;
    out.push({
      pid,
      name: cells[0],
      command: cells[0],
    });
  }
  return out;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
      continue;
    }
    if (ch === "," && !inQuote) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function basenameOf(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * On Linux, `ptrace(PTRACE_ATTACH, …)` is restricted by default.
 * Returns a hint string when the host is configured in a way that
 * will cause attach to fail with `EPERM`, or `null` when permissions
 * look fine. Mythos surfaces the hint in the launch error so users do
 * not need to grep kernel docs.
 */
export function checkPtraceScopeHint(): string | null {
  if (process.platform !== "linux") return null;
  try {
    const v = readFileSync("/proc/sys/kernel/yama/ptrace_scope", "utf8").trim();
    if (v === "0") return null;
    return [
      `Linux yama ptrace_scope is set to ${v}.`,
      "Attach may require sudo or `echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope`",
      "(see https://docs.kernel.org/admin-guide/LSM/Yama.html).",
    ].join(" ");
  } catch {
    return null;
  }
}

/**
 * Resolve a user-supplied attach configuration to a concrete PID.
 *
 * Accepts either:
 *   - `processId` — a number; returned as-is after a liveness check
 *   - `processName` — a basename / substring; matched against the
 *     running process list. If more than one match is found, the
 *     caller is expected to surface a picker — we throw with the
 *     candidate list so the IDE can render it.
 */
export interface AttachSelector {
  processId?: number;
  processName?: string;
}

export function resolveAttachPid(selector: AttachSelector): number {
  if (selector.processId !== undefined) {
    if (!Number.isFinite(selector.processId) || selector.processId <= 0) {
      throw new Error(`Invalid processId: ${selector.processId}`);
    }
    // `kill -0` is a portable existence probe on POSIX; on Windows we
    // skip the check (the underlying debugger will reject a missing PID).
    if (process.platform !== "win32") {
      try {
        process.kill(selector.processId, 0);
      } catch (err) {
        const hint = checkPtraceScopeHint();
        const tail = hint ? ` ${hint}` : "";
        throw new Error(
          `Cannot attach to PID ${selector.processId}: ${(err as NodeJS.ErrnoException).message}.${tail}`,
        );
      }
    }
    return selector.processId;
  }

  if (selector.processName !== undefined) {
    const candidates = findProcesses({ name: selector.processName }).filter(
      // Skip ourselves so users cannot accidentally attach to mythosdbg.
      (p) => p.pid !== process.pid,
    );
    if (candidates.length === 0) {
      throw new Error(
        `No running process matches '${selector.processName}'. Pass a numeric processId, or start the program first.`,
      );
    }
    if (candidates.length > 1) {
      const list = candidates
        .slice(0, 8)
        .map((p) => `pid=${p.pid} name=${p.name}`)
        .join(", ");
      throw new Error(
        `Multiple processes match '${selector.processName}': ${list}${candidates.length > 8 ? ", …" : ""}. Pass a numeric processId.`,
      );
    }
    return candidates[0].pid;
  }

  throw new Error("attach requires either processId or processName.");
}
