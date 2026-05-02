import { createServer, Socket } from "node:net";
import { describe, expect, it } from "vitest";
import {
  createTcpTransport,
  createSubprocessTransport,
  createRemoteTransport,
  type DapTransport,
} from "../src/core/transport";

/**
 * Transport tests use a tiny in-process TCP echo server to exercise
 * the TCP path end-to-end without depending on external tools. The
 * SSH path cannot be unit-tested without a real ssh client; we verify
 * shape only (validation rejects when sshHost is missing, etc.).
 */

function startEchoServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = createServer((sock: Socket) => {
      sock.on("data", (chunk) => sock.write(chunk));
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) {
        resolve({ port: addr.port, close: () => server.close() });
      } else {
        reject(new Error("listen returned no address"));
      }
    });
  });
}

async function readOnce(t: DapTransport, timeoutMs = 1_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    t.onData((chunk) => {
      clearTimeout(timer);
      resolve(chunk);
    });
    t.onError((err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe("createTcpTransport", () => {
  it("connects, round-trips bytes, and closes cleanly", async () => {
    const server = await startEchoServer();
    try {
      const t = await createTcpTransport({ host: "127.0.0.1", port: server.port });
      const reply = readOnce(t);
      t.write(Buffer.from("hello"));
      expect((await reply).toString()).toBe("hello");
      t.close();
    } finally {
      server.close();
    }
  });

  it("rejects when the host is unreachable", async () => {
    // Port 1 is privileged and never has a listener in test envs.
    await expect(
      createTcpTransport({ host: "127.0.0.1", port: 1, timeoutMs: 250 }),
    ).rejects.toBeDefined();
  });
});

describe("createSubprocessTransport", () => {
  it("spawns a process and surfaces its stdout via onData", async () => {
    const t = createSubprocessTransport({
      command: process.execPath,
      args: ["-e", "process.stdout.write('hi'); setTimeout(()=>process.exit(0), 50)"],
    });
    const buf = await readOnce(t);
    expect(buf.toString()).toBe("hi");
    t.close();
  });
});

describe("createRemoteTransport", () => {
  it("dispatches to TCP by default", async () => {
    const server = await startEchoServer();
    try {
      const t = await createRemoteTransport({
        host: "127.0.0.1",
        port: server.port,
      });
      const reply = readOnce(t);
      t.write(Buffer.from("ping"));
      expect((await reply).toString()).toBe("ping");
      t.close();
    } finally {
      server.close();
    }
  });

  it("rejects ssh transport without sshHost", async () => {
    await expect(
      createRemoteTransport({
        host: "10.0.0.1",
        port: 1234,
        transport: "ssh",
      }),
    ).rejects.toThrow(/sshHost/);
  });

  it("rejects unknown transport name", async () => {
    await expect(
      createRemoteTransport({
        host: "10.0.0.1",
        port: 1234,
        transport: "websocket" as unknown as "tcp",
      }),
    ).rejects.toThrow(/Unknown remote transport/);
  });
});
