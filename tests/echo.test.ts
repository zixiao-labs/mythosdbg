import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type { DebugProtocol } from "@vscode/debugprotocol";

/**
 * Round-trip the echo runtime through the full server: spawn `node
 * dist/server.js`, drive a real DAP handshake (initialize → launch
 * → threads → continue → terminated), and assert the responses.
 *
 * This exercises:
 *   - Content-Length framing parser/encoder
 *   - MythosSession dispatch
 *   - EchoRuntime synthetic state machine
 *
 * If `dist/server.js` does not exist (build wasn't run) the test
 * is skipped — CI runs `npm run build` first.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(__dirname, "..", "dist", "server.js");

const HEADER_TERMINATOR = Buffer.from("\r\n\r\n");
const CL_PREFIX = "content-length:";

function encode(msg: DebugProtocol.ProtocolMessage): Buffer {
  const body = JSON.stringify(msg);
  const head = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
  return Buffer.concat([Buffer.from(head, "ascii"), Buffer.from(body, "utf8")]);
}

class Decoder {
  private buf: Buffer = Buffer.alloc(0);

  push(c: Buffer): void {
    this.buf = this.buf.length === 0 ? c : Buffer.concat([this.buf, c]);
  }

  *drain(): Generator<DebugProtocol.ProtocolMessage> {
    while (true) {
      const end = this.buf.indexOf(HEADER_TERMINATOR);
      if (end < 0) return;
      let len = -1;
      for (const line of this.buf.subarray(0, end).toString("ascii").split("\r\n")) {
        if (line.toLowerCase().startsWith(CL_PREFIX)) {
          len = Number(line.slice(CL_PREFIX.length).trim());
        }
      }
      if (len < 0) {
        this.buf = Buffer.alloc(0);
        return;
      }
      const total = end + HEADER_TERMINATOR.length + len;
      if (this.buf.length < total) return;
      const body = this.buf.subarray(end + HEADER_TERMINATOR.length, total);
      this.buf = this.buf.subarray(total);
      yield JSON.parse(body.toString("utf8")) as DebugProtocol.ProtocolMessage;
    }
  }
}

describe("EchoRuntime end-to-end DAP handshake", () => {
  it("initialize → launch → threads → continue → terminated", async () => {
    const { existsSync } = await import("node:fs");
    if (!existsSync(SERVER_ENTRY)) {
      console.warn(`Skipping: build first (${SERVER_ENTRY} not found)`);
      return;
    }
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const decoder = new Decoder();
    const messages: DebugProtocol.ProtocolMessage[] = [];

    child.stdout!.on("data", (c: Buffer) => {
      decoder.push(c);
      for (const msg of decoder.drain()) messages.push(msg);
    });

    let nextSeq = 1;
    function send(command: string, args?: unknown): number {
      const seq = nextSeq++;
      child.stdin!.write(
        encode({
          seq,
          type: "request",
          command,
          arguments: args,
        } as DebugProtocol.Request),
      );
      return seq;
    }

    async function waitFor(
      predicate: (m: DebugProtocol.ProtocolMessage) => boolean,
      timeoutMs = 5_000,
    ): Promise<DebugProtocol.ProtocolMessage> {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const found = messages.find(predicate);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(
        `timeout waiting; messages so far:\n${JSON.stringify(messages, null, 2)}`,
      );
    }

    try {
      const initSeq = send("initialize", {
        clientID: "test",
        adapterID: "mythos-echo",
        pathFormat: "path",
      });
      await waitFor(
        (m) =>
          m.type === "response" &&
          (m as DebugProtocol.Response).request_seq === initSeq,
      );
      await waitFor(
        (m) => m.type === "event" && (m as DebugProtocol.Event).event === "initialized",
      );

      const launchSeq = send("launch", {
        type: "mythos-echo",
        request: "launch",
        name: "Echo",
      });
      await waitFor(
        (m) =>
          m.type === "response" &&
          (m as DebugProtocol.Response).request_seq === launchSeq &&
          (m as DebugProtocol.Response).success,
      );
      await waitFor(
        (m) =>
          m.type === "event" &&
          (m as DebugProtocol.Event).event === "stopped" &&
          ((m as DebugProtocol.StoppedEvent).body.reason === "entry"),
      );

      const threadsSeq = send("threads");
      const threadsResp = (await waitFor(
        (m) =>
          m.type === "response" &&
          (m as DebugProtocol.Response).request_seq === threadsSeq,
      )) as DebugProtocol.ThreadsResponse;
      expect(threadsResp.body.threads).toEqual([
        { id: 1, name: "echo-main" },
      ]);

      send("continue", { threadId: 1 });
      await waitFor(
        (m) => m.type === "event" && (m as DebugProtocol.Event).event === "terminated",
        7_000,
      );
    } finally {
      try { child.kill(); } catch { /* ignore */ }
    }
  });
});
