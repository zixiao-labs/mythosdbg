# Mythos ↔ Logos integration spec

This document pins the contract between [`mythosdbg`](https://github.com/zixiao-labs/mythosdbg)
and the Logos workstation. Logos discovers Mythos through an optional
download (`extras:mythos:install`) and spawns the bundled DAP server
out-of-process. The contract below is what each side guarantees about
the other.

## 1. Release artifacts

A Mythos release publishes the following assets on the GitHub
Release page (`v<MAJOR>.<MINOR>.<PATCH>`):

| Asset name                                       | Purpose                                         |
| ------------------------------------------------ | ----------------------------------------------- |
| `mythosdbg-${arch}.tar.gz`                       | Packed adapter (npm-pack layout, see §3 below). |
| `mythosdbg-${arch}.tar.gz.sha256`                | One-line `sha256sum`-format checksum.           |
| `mythosdbg-${arch}.tar.gz.sig` (optional)        | Detached cosign signature, when available.      |

`${arch}` is one of:

- `darwin-arm64`
- `darwin-x64`
- `linux-x64`
- `linux-arm64`
- `win32-x64`

### Checksum format

A single line, byte-for-byte compatible with GNU `sha256sum`:

```
<lowercase-hex>  mythosdbg-${arch}.tar.gz
```

Logos's installer verifies the file before unpacking. A mismatch
aborts the install and surfaces the expected vs. actual digest.

## 2. Tarball layout

The tarball is the output of `npm pack`, gzipped. After extraction
under `${userData}/extras/mythosdbg/`:

```
package/
  package.json                # `version`, `bin`, `main`, `engines`
  dist/
    server.js                 # the DAP entry point
    runDebugAdapter.js        # bin shim
    core/…
    runtimes/…
  README.md
  Lore.md
  LICENSE
  bundled/                    # optional — see §3.1
    lldb-dap-${arch}          # e.g. when Mythos ships a private LLDB
    debugpy/                  # e.g. when Mythos vends a debugpy snapshot
```

Logos must accept either of these layouts:

1. **Packed** — the directory above lives under a wrapping `package/`
   folder (npm pack's default).
2. **Raw** — `dist/server.js` lives at the root of the extracted
   tarball.

In practice Logos checks for `package/dist/server.js` first and falls
back to `dist/server.js`. This stays robust against tarballs produced
by hand vs. by the release workflow.

### 2.1 Bundled native binaries

Mythos may ship a private copy of the underlying debugger inside the
tarball (e.g. a known-good `lldb-dap`). When present, the runtime
prefers the bundled binary over a system-installed one. The bundled
copy lives at `package/bundled/${tool}-${arch}{.exe}` and is
chmod-`0755` on POSIX. The release workflow signs / notarizes these
when a code-signing identity is configured.

## 3. Spawn contract

Logos spawns the adapter as a child process:

```ts
spawn(process.execPath, [path.join(extracted, "dist", "server.js")], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});
```

The adapter speaks Content-Length-framed DAP on stdio. Stderr is
treated as opaque diagnostic output and forwarded to the workbench's
debug console under `category: "stderr"`.

## 4. Capability handshake

After the workbench sends `initialize` and Mythos replies with
`InitializeResponse` and the standard `initialized` event, Mythos
emits a custom DAP event:

```jsonc
{
  "type": "event",
  "event": "mythos/capabilities",
  "body": {
    "mythosVersion": "0.1.0",
    "schemaVersion": 1,
    "minimumLogosVersion": "1.2.0",
    "supportedTypes": [
      "mythos-echo",
      "mythos-cpp",
      "mythos-python",
      "mythos-go",
      "mythos-rust",
      "mythos-lua"
    ],
    "features": {
      "remote": false,
      "attach": true
    }
  }
}
```

Field semantics:

- `mythosVersion` — `package.json#version` of the running adapter.
- `schemaVersion` — bumped when the body's shape changes in a
  breaking way. Logos refuses to load adapters whose schema is newer
  than the workbench understands.
- `minimumLogosVersion` — Logos refuses to start the session if its
  own version is older than this.
- `supportedTypes` — the DAP `type` strings the adapter accepts on
  `launch` / `attach`. Logos uses these to decide which runtime
  contributions to register.
- `features` — coarse feature switches the workbench may key UI off
  of. Forward-compatible: unknown keys are ignored.

The event is informational only — Logos must still be prepared for
`launch` to fail with an `unsupported launch type` error if the
runtime list goes out of date.

## 5. Versioning

Mythos follows semver. Compatibility rules:

- A patch bump (`0.1.0 → 0.1.1`) never changes the spawn contract,
  schema version, or required Logos version.
- A minor bump (`0.1.x → 0.2.0`) may add fields to `mythos/capabilities`
  but must not remove or rename them.
- A major bump may change the spawn contract or schema version. The
  release notes call this out explicitly.

## 6. Local development

To dry-run a Mythos build against Logos without a published release:

```sh
cd /path/to/mythosdbg
npm pack
# Place the tarball wherever Logos's `extras:mythos:install` flow
# expects it, OR temporarily edit MYTHOS_REPO discovery to point at
# a `file://` URL.
```

The Logos-side tracking issue
([logos#39](https://github.com/zixiao-labs/logos/issues/39)) covers
the manual end-to-end checklist.
