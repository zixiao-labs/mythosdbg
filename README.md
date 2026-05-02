# mythosdbg
                                                                                                                            
Mythos Debugger - Logos Ecosystem - Your programming career only needs one debug adapter.

Codename：TIANSHI PILLAR（See Lore.md for details.）

## Status

v0.0.0 prototype (Stage 3.5 of the Logos workstation dev plan).

What works:
- DAP server skeleton (TypeScript, `@vscode/debugadapter`)
- `mythos-echo` runtime — a no-op runtime used by the self-test
- `mythos-cpp` prototype:
  - POSIX: proxies `lldb-dap` (LLVM 18+) for C/C++
  - Windows: drives `cdb.exe` (Windows SDK Debugging Tools) — v0.0
    prototype covering stop / step / variables / call stack

What's open (see GitHub issues):
- Source mapping / DWARF / PDB layer
- JIT-attach flow
- Remote debugging (gdbserver / lldb-server)
- Python / Rust / Go / Lua runtimes
- Logos integration IPC formalization

## Run

```sh
npm install
npm run build
node dist/server.js   # speak DAP over stdio
```

In Logos, this binary is dropped under `${userData}/extras/mythosdbg/`
by the optional-download flow exposed in Settings → Debugging.
