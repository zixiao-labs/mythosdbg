import { describe, expect, it } from "vitest";
import type { DebugProtocol } from "@vscode/debugprotocol";
import { MythosSession, type MythosCapabilities } from "../src/core/mythosSession";
import type { Runtime, LaunchArguments } from "../src/core/runtime";

/**
 * MythosSession should emit a `mythos/capabilities` event right after
 * the standard `initialized` event when capabilities are configured.
 * The wire shape of the event body is part of the integration spec
 * in `docs/integration.md`; this test pins it.
 */

class CapturingSession extends MythosSession {
  readonly events: DebugProtocol.Event[] = [];
  readonly responses: DebugProtocol.Response[] = [];
  // sendEvent / sendResponse are protected, so we override them inside
  // the subclass to capture wire traffic instead of writing it to a
  // socket. `protected` access is legal here even with `noImplicitAny`.
  override sendEvent(event: DebugProtocol.Event): void {
    this.events.push(event);
  }
  override sendResponse(response: DebugProtocol.Response): void {
    this.responses.push(response);
  }
}

const stubRuntime = (_config: LaunchArguments): Runtime => ({
  id: "stub",
  start: async () => undefined,
  handle: async () => ({}),
  dispose: async () => undefined,
});

describe("mythos/capabilities event", () => {
  it("is not emitted when no capabilities are configured", () => {
    const session = new CapturingSession(stubRuntime);
    // initializeRequest is protected; we drive it through dispatchRequest
    // to keep the call path realistic.
    (session as unknown as {
      initializeRequest: (
        r: DebugProtocol.InitializeResponse,
        a: DebugProtocol.InitializeRequestArguments,
      ) => void;
    }).initializeRequest(
      { seq: 0, type: "response", request_seq: 1, success: true, command: "initialize" } as DebugProtocol.InitializeResponse,
      { clientID: "test", adapterID: "mythos-echo", pathFormat: "path" } as DebugProtocol.InitializeRequestArguments,
    );
    const initialized = session.events.find((e) => e.event === "initialized");
    expect(initialized).toBeDefined();
    const caps = session.events.find((e) => e.event === "mythos/capabilities");
    expect(caps).toBeUndefined();
  });

  it("is emitted with the configured body right after `initialized`", () => {
    const capabilities: MythosCapabilities = {
      mythosVersion: "0.1.2",
      schemaVersion: 1,
      minimumLogosVersion: "1.2.0",
      supportedTypes: ["mythos-echo", "mythos-cpp"],
      features: { attach: false, remote: false },
    };
    const session = new CapturingSession(stubRuntime, { capabilities });
    (session as unknown as {
      initializeRequest: (
        r: DebugProtocol.InitializeResponse,
        a: DebugProtocol.InitializeRequestArguments,
      ) => void;
    }).initializeRequest(
      { seq: 0, type: "response", request_seq: 1, success: true, command: "initialize" } as DebugProtocol.InitializeResponse,
      { clientID: "test", adapterID: "mythos-echo", pathFormat: "path" } as DebugProtocol.InitializeRequestArguments,
    );
    const ix = session.events.findIndex((e) => e.event === "initialized");
    const caps = session.events[ix + 1];
    expect(caps).toBeDefined();
    expect(caps.event).toBe("mythos/capabilities");
    expect(caps.body).toEqual(capabilities);
  });
});
