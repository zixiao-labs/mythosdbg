import { existsSync } from "node:fs";
import path from "node:path";
import type { DebugProtocol } from "@vscode/debugprotocol";
import { HandlePool } from "./handles.js";

/**
 * Platform-agnostic source path resolver.
 *
 * Real-world C/C++/Rust/Go workflows hit a lot of source-path mismatch
 * between the build machine and the developer machine — especially when
 * binaries come from CI containers or are debugged remotely. This
 * resolver lets every runtime apply the same rewrite rules without each
 * one re-implementing them:
 *
 *   1. **`sourceMap`** — a flat dictionary mapping build-side prefixes
 *      to host-side prefixes. Example:
 *
 *      ```json
 *      "sourceMap": {
 *        "/build/myproject":            "${workspaceFolder}/myproject",
 *        "/rustc/abc1234":              "${workspaceFolder}/.rustup-src"
 *      }
 *      ```
 *
 *      Mappings are checked longest-first so a more specific prefix wins.
 *      Both keys and values support a single `${workspaceFolder}`
 *      substitution.
 *
 *   2. **`symbolSearchPath`** — additional directories the runtime
 *      should hand to the underlying debugger when looking up debug
 *      info (e.g. lldb's `target.debug-file-search-paths`). The
 *      resolver itself does not read DWARF/PDB; it only forwards the
 *      list. Runtimes use it to build their `initCommands`.
 *
 * After a rewrite, the resolver checks whether the host-side path
 * exists on disk:
 *
 *   - **Hit** → returns a Source with the rewritten `path` and a
 *     `sourceReference` of 0 (DAP convention: client reads from disk).
 *
 *   - **Miss** → returns a Source with **no path** but a non-zero
 *     `sourceReference`. The workbench follows up with a `source`
 *     request which the runtime forwards to `getBody(ref)`. The body
 *     in this resolver is a stub pointing back at the original
 *     build-side path; richer runtimes (DWARF `.debug_str` /
 *     `.debug_line`, PDB) can override it.
 *
 * The resolver does NOT attempt to parse DWARF / PDB itself —
 * upstream debuggers (lldb-dap, debugpy, dlv) already carry that
 * machinery, and we want to stay forkless. Future Mythos work that
 * fetches inlined source from .dwz / split DWARF will live behind
 * the same `getBody(ref)` hook.
 */

const WORKSPACE_FOLDER_TOKEN = "${workspaceFolder}";

export interface SourceResolverOptions {
  /** Build-side → host-side path-prefix map. Order does not matter. */
  sourceMap?: Record<string, string>;
  /** Resolve `${workspaceFolder}` to this absolute path. */
  workspaceFolder?: string;
  /** Symbol search path (forwarded verbatim to runtimes). */
  symbolSearchPath?: string[];
  /**
   * Override the on-disk existence probe (used by tests so we do not
   * touch the real filesystem).
   */
  fileExists?: (p: string) => boolean;
}

export interface RewrittenSource {
  source: DebugProtocol.Source;
  /** True when the rewrite produced an existing host-side path. */
  hit: boolean;
  /** Original build-side path before the rewrite. */
  originalPath?: string;
}

interface MissEntry {
  originalPath: string;
  rewrittenPath: string;
  sourceName?: string;
}

export class SourceResolver {
  private readonly mappings: Array<{ from: string; to: string }>;
  private readonly workspaceFolder?: string;
  private readonly fileExists: (p: string) => boolean;
  private readonly missPool = new HandlePool<MissEntry>();
  readonly symbolSearchPath: readonly string[];

  constructor(options: SourceResolverOptions = {}) {
    this.workspaceFolder = options.workspaceFolder;
    this.fileExists = options.fileExists ?? ((p: string) => existsSync(p));
    this.symbolSearchPath = options.symbolSearchPath
      ? [...options.symbolSearchPath].map((p) => this.expand(p))
      : [];
    const raw = options.sourceMap ?? {};
    this.mappings = Object.entries(raw)
      .map(([from, to]) => ({ from: this.expand(from), to: this.expand(to) }))
      // Longest match wins; sort once so rewriteSource can be linear.
      .sort((a, b) => b.from.length - a.from.length);
  }

  /**
   * Rewrite a Source object as it appears in a stack frame / module
   * response. Returns the (possibly transformed) Source plus a flag
   * saying whether the host-side path exists.
   */
  rewriteSource(source: DebugProtocol.Source | undefined): RewrittenSource {
    if (!source) {
      return { source: source as unknown as DebugProtocol.Source, hit: false };
    }
    // No path at all (already a synthesized DAP source) — leave alone.
    if (!source.path) return { source, hit: false };

    const rewritten = this.rewritePath(source.path);
    if (rewritten === source.path) {
      // Even without a rewrite, surface missing-on-disk via reference.
      const exists = this.fileExists(source.path);
      if (exists) return { source, hit: true };
      return {
        source: this.materializeMiss(source.path, source.path, source.name),
        hit: false,
        originalPath: source.path,
      };
    }
    if (this.fileExists(rewritten)) {
      return {
        source: { ...source, path: rewritten, sourceReference: 0 },
        hit: true,
        originalPath: source.path,
      };
    }
    return {
      source: this.materializeMiss(source.path, rewritten, source.name),
      hit: false,
      originalPath: source.path,
    };
  }

  /**
   * Apply the rewrite to every frame in a `stackTrace` response body.
   * Returned object is a shallow clone so callers can hand it to
   * `sendResponse` directly.
   */
  rewriteStackTraceBody(
    body: DebugProtocol.StackTraceResponse["body"],
  ): DebugProtocol.StackTraceResponse["body"] {
    if (!body || !Array.isArray(body.stackFrames)) return body;
    const stackFrames = body.stackFrames.map((frame) => ({
      ...frame,
      source: this.rewriteSource(frame.source).source,
    }));
    return { ...body, stackFrames };
  }

  /**
   * Apply the rewrite to a `loadedSources` response body.
   */
  rewriteLoadedSourcesBody(
    body: DebugProtocol.LoadedSourcesResponse["body"],
  ): DebugProtocol.LoadedSourcesResponse["body"] {
    if (!body || !Array.isArray(body.sources)) return body;
    const sources = body.sources.map((s) => this.rewriteSource(s).source);
    return { ...body, sources };
  }

  /**
   * Returns a synthesized `source` body for a previously-issued
   * sourceReference, or null if the reference was not allocated by
   * this resolver.
   *
   * Subclasses (or the next iteration of this resolver) can override
   * this to fetch real bytes from DWARF `.debug_str` / `.debug_line`,
   * PDB, or a remote source service.
   */
  getBody(reference: number): { content: string; mimeType?: string } | null {
    const entry = this.missPool.get(reference);
    if (!entry) return null;
    return {
      content: [
        `// Source not available on this host.`,
        `// Build-side path:   ${entry.originalPath}`,
        `// After sourceMap:   ${entry.rewrittenPath}`,
        ``,
        `// Hint: add an entry to launch.json's "sourceMap" so this`,
        `// path resolves to a directory on the developer machine, or`,
        `// re-build with -fdebug-prefix-map=${entry.originalPath}=${"${workspaceFolder}"}/...`,
      ].join("\n"),
      mimeType: "text/plain",
    };
  }

  /**
   * Whether a sourceReference was minted by this resolver. Runtimes
   * use this to decide whether to forward a `source` request to the
   * underlying debugger or answer it locally.
   */
  ownsReference(reference: number): boolean {
    return this.missPool.get(reference) !== undefined;
  }

  private materializeMiss(
    originalPath: string,
    rewrittenPath: string,
    sourceName?: string,
  ): DebugProtocol.Source {
    const ref = this.missPool.create({ originalPath, rewrittenPath, sourceName });
    return {
      // DAP: when sourceReference > 0, path should be omitted so the
      // workbench knows to call back via `source`.
      name: sourceName ?? path.basename(originalPath),
      sourceReference: ref,
      origin: "mythos source resolver",
      // Tag the source with the original path via `adapterData` for
      // diagnostics / UI tooltips.
      adapterData: { originalPath, rewrittenPath },
    };
  }

  private rewritePath(p: string): string {
    const normalized = this.normalize(p);
    for (const m of this.mappings) {
      const from = this.normalize(m.from);
      if (normalized === from || normalized.startsWith(from + "/")) {
        return m.to + p.slice(m.from.length);
      }
      // Windows tolerates either separator; check the alt-slash form too.
      if (process.platform === "win32") {
        const fromAlt = from.replace(/\//g, "\\");
        if (normalized.startsWith(fromAlt + "\\")) {
          return m.to + p.slice(m.from.length);
        }
      }
    }
    return p;
  }

  private normalize(p: string): string {
    if (process.platform === "win32") {
      return p.replace(/\\/g, "/").toLowerCase();
    }
    return p;
  }

  private expand(p: string): string {
    if (!p.includes(WORKSPACE_FOLDER_TOKEN)) return p;
    if (!this.workspaceFolder) {
      throw new Error(
        "${workspaceFolder} appears in sourceMap but no workspaceFolder was provided.",
      );
    }
    return p.split(WORKSPACE_FOLDER_TOKEN).join(this.workspaceFolder);
  }
}

/**
 * Convenience: build a resolver from launch.json keys we already
 * pass through verbatim.
 */
export function buildResolverFromLaunchConfig(
  config: { sourceMap?: Record<string, string>; symbolSearchPath?: string[] } & Record<string, unknown>,
  workspaceFolder?: string,
  fileExists?: (p: string) => boolean,
): SourceResolver {
  return new SourceResolver({
    sourceMap: config.sourceMap,
    symbolSearchPath: config.symbolSearchPath,
    workspaceFolder,
    fileExists,
  });
}
