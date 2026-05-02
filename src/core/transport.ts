import { spawn, type ChildProcess } from "node:child_process";
import { Socket, connect as netConnect } from "node:net";
import { Buffer } from "node:buffer";

/**
 * Transport abstraction for DAP byte streams.
 *
 * A transport hides the difference between:
 *   - a locally spawned debugger subprocess that speaks DAP over its
 *     own stdio (today's `cppLldb` behavior),
 *   - a TCP connection to a remote `lldb-server` / `gdbserver` /
 *     debugpy `--listen` endpoint,
 *   - an SSH stdio tunnel (`ssh -W host:port user@gateway`) that
 *     proxies the same TCP target without requiring a local listener
 *     or a separate port-forward step.
 *
 * The interface is deliberately tiny — the consumer (each runtime's
 * framing/dispatch loop) only needs `write` to push frames out and
 * a `data` event source to read frames in. `close()` releases all
 * underlying handles.
 *
 * Adding a new transport (e.g. a WebSocket URL the user pastes into
 * launch.json) only requires implementing `DapTransport`.
 */

export interface DapTransport {
  /** Write a chunk of DAP bytes (already framed) to the remote end. */
  write(chunk: Buffer | string): void;
  /** Subscribe to inbound bytes. Multiple subscribers are fine. */
  onData(listener: (chunk: Buffer) => void): void;
  /** Subscribe to fatal errors. The transport may be unusable after firing. */
  onError(listener: (err: Error) => void): void;
  /** Subscribe to remote-initiated close. */
  onClose(listener: (info: { code?: number | null; reason?: string }) => void): void;
  /** Tear down the transport. Idempotent. */
  close(): void;
}

/* --------------------------------------------------------------- */
/* Subprocess                                                       */
/* --------------------------------------------------------------- */

export interface SubprocessTransportOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
}

export function createSubprocessTransport(
  options: SubprocessTransportOptions,
): DapTransport & { stderr?: NodeJS.ReadableStream; child: ChildProcess } {
  const child = spawn(options.command, options.args ? [...options.args] : [], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });
  const dataListeners: Array<(chunk: Buffer) => void> = [];
  const errorListeners: Array<(err: Error) => void> = [];
  const closeListeners: Array<(info: { code?: number | null }) => void> = [];

  child.stdout?.on("data", (c: Buffer) => {
    for (const l of dataListeners) l(c);
  });
  child.once("error", (err) => {
    for (const l of errorListeners) l(err);
  });
  child.once("exit", (code) => {
    for (const l of closeListeners) l({ code });
  });

  return {
    child,
    stderr: child.stderr ?? undefined,
    write(chunk) {
      child.stdin?.write(chunk);
    },
    onData(l) {
      dataListeners.push(l);
    },
    onError(l) {
      errorListeners.push(l);
    },
    onClose(l) {
      closeListeners.push(l);
    },
    close() {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    },
  };
}

/* --------------------------------------------------------------- */
/* TCP                                                              */
/* --------------------------------------------------------------- */

export interface TcpTransportOptions {
  host: string;
  port: number;
  /** Connect timeout in milliseconds; default 10s. */
  timeoutMs?: number;
}

export async function createTcpTransport(
  options: TcpTransportOptions,
): Promise<DapTransport & { socket: Socket }> {
  const socket = await connectSocket(options);
  return wrapSocket(socket, () => `tcp://${options.host}:${options.port}`);
}

function connectSocket(options: TcpTransportOptions): Promise<Socket> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return new Promise<Socket>((resolve, reject) => {
    const sock = netConnect({ host: options.host, port: options.port });
    const timer = setTimeout(() => {
      sock.destroy(new Error(`Timed out connecting to ${options.host}:${options.port} after ${timeoutMs}ms`));
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function wrapSocket(
  socket: Socket,
  describe: () => string,
): DapTransport & { socket: Socket } {
  const dataListeners: Array<(chunk: Buffer) => void> = [];
  const errorListeners: Array<(err: Error) => void> = [];
  const closeListeners: Array<(info: { reason?: string }) => void> = [];

  socket.on("data", (c: Buffer) => {
    for (const l of dataListeners) l(c);
  });
  socket.once("error", (err) => {
    for (const l of errorListeners) l(err);
  });
  socket.once("close", () => {
    for (const l of closeListeners) l({ reason: `${describe()} closed` });
  });

  return {
    socket,
    write(chunk) {
      socket.write(chunk);
    },
    onData(l) {
      dataListeners.push(l);
    },
    onError(l) {
      errorListeners.push(l);
    },
    onClose(l) {
      closeListeners.push(l);
    },
    close() {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    },
  };
}

/* --------------------------------------------------------------- */
/* SSH                                                              */
/* --------------------------------------------------------------- */

export interface SshTransportOptions {
  /** SSH login host, e.g. "user@bastion" or "bastion". */
  sshHost: string;
  /** Optional SSH user (omit when sshHost already encodes it). */
  sshUser?: string;
  /** Final TCP target reachable from the SSH host. */
  host: string;
  port: number;
  /** Path to a private key file (forwarded as `-i`). */
  identityFile?: string;
  /**
   * Extra arguments passed to `ssh` after our defaults, useful for
   * `-p`, `-J`, `-o ProxyCommand=…`, etc.
   */
  extraArgs?: readonly string[];
  /** Optional override for the ssh executable (default: `ssh`). */
  sshCommand?: string;
}

/**
 * SSH stdio tunnel: spawns `ssh -W host:port [-i key] [user@]hostname`
 * and treats its stdio as the DAP byte stream. This is functionally
 * equivalent to running `lldb-server platform --listen *:port` on the
 * remote host and connecting TCP, but does not require a publicly
 * reachable port — the bytes flow over the existing SSH connection.
 *
 * `ssh -W` is supported by OpenSSH 5.4+ which is universal in
 * practice. We forward stderr to the caller so authentication
 * prompts and errors land in the workbench's debug console.
 */
export function createSshTransport(
  options: SshTransportOptions,
): DapTransport & { stderr: NodeJS.ReadableStream } {
  const target = options.sshUser ? `${options.sshUser}@${options.sshHost}` : options.sshHost;
  const args: string[] = [];
  if (options.identityFile) args.push("-i", options.identityFile);
  // -T disables pseudo-terminal allocation (we are not interactive).
  // -o BatchMode=yes prevents ssh from blocking on a password prompt
  // when no key/agent matches; users who need password auth can
  // unset this through extraArgs.
  args.push("-T", "-o", "BatchMode=yes");
  args.push("-W", `${options.host}:${options.port}`);
  if (options.extraArgs) args.push(...options.extraArgs);
  args.push(target);

  const child = spawn(options.sshCommand ?? "ssh", args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const dataListeners: Array<(chunk: Buffer) => void> = [];
  const errorListeners: Array<(err: Error) => void> = [];
  const closeListeners: Array<(info: { code?: number | null }) => void> = [];

  child.stdout?.on("data", (c: Buffer) => {
    for (const l of dataListeners) l(c);
  });
  child.once("error", (err) => {
    for (const l of errorListeners) l(err);
  });
  child.once("exit", (code) => {
    for (const l of closeListeners) l({ code });
  });

  if (!child.stderr) {
    throw new Error("ssh subprocess has no stderr; cannot proxy diagnostics");
  }

  return {
    stderr: child.stderr,
    write(chunk) {
      child.stdin?.write(chunk);
    },
    onData(l) {
      dataListeners.push(l);
    },
    onError(l) {
      errorListeners.push(l);
    },
    onClose(l) {
      closeListeners.push(l);
    },
    close() {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    },
  };
}

/* --------------------------------------------------------------- */
/* launch.json mapping                                              */
/* --------------------------------------------------------------- */

export interface RemoteLaunchBlock {
  host: string;
  port: number;
  transport?: "tcp" | "ssh";
  sshHost?: string;
  sshUser?: string;
  identityFile?: string;
  sshArgs?: string[];
  timeoutMs?: number;
}

/**
 * Build a transport from a launch.json `remote` block. The runtime
 * stays oblivious to which kind of remote we picked.
 *
 * Exported for use by every runtime that has a remote story
 * (cppLldb today, debugpy `--listen` next).
 */
export async function createRemoteTransport(
  remote: RemoteLaunchBlock,
): Promise<DapTransport> {
  const transport = remote.transport ?? "tcp";
  if (transport === "tcp") {
    return createTcpTransport({
      host: remote.host,
      port: remote.port,
      timeoutMs: remote.timeoutMs,
    });
  }
  if (transport === "ssh") {
    if (!remote.sshHost) {
      throw new Error("remote.transport=ssh requires remote.sshHost");
    }
    return createSshTransport({
      sshHost: remote.sshHost,
      sshUser: remote.sshUser,
      host: remote.host,
      port: remote.port,
      identityFile: remote.identityFile,
      extraArgs: remote.sshArgs,
    });
  }
  throw new Error(`Unknown remote transport '${String(transport)}'`);
}
