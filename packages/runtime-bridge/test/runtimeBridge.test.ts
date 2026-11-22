import { describe, expect, it } from "vitest";
import { connectReactNativeAgent } from "../src/index";

describe("React Native runtime bridge instrumentation", () => {
  it("reports network data while preserving fetch behavior and redacting credentials", async () => {
    const globalRecord = globalThis as typeof globalThis & { WebSocket?: typeof WebSocket };
    const previousSocket = globalRecord.WebSocket;
    const previousFetch = globalThis.fetch;
    const messages: Array<Record<string, unknown>> = [];
    class FakeSocket {
      static OPEN = 1;
      readyState = 1;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      send(message: string): void { messages.push(JSON.parse(message) as Record<string, unknown>); }
      close(): void { this.readyState = 3; }
    }
    Object.assign(globalRecord, { WebSocket: FakeSocket as unknown as typeof WebSocket });
    globalThis.fetch = async () => new Response('{"access_token":"response-secret","value":1}', { status: 201, headers: { authorization: "response-secret" } });
    const bridge = connectReactNativeAgent({ url: "ws://127.0.0.1:1/rn-agent?token=sample", captureConsole: false, captureErrors: false });
    try {
      const response = await globalThis.fetch("https://service.test/data?api_key=url-secret", {
        method: "POST",
        headers: { authorization: "request-secret" },
        body: '{"password":"body-secret"}'
      });
      expect(response.status).toBe(201);
      expect(await response.text()).toContain("response-secret");
      const event = messages[0];
      expect(event.type).toBe("network");
      expect(event.url).toBe("https://service.test/data?api_key=%5BREDACTED%5D");
      expect(event.requestHeaders).toEqual({ authorization: "[REDACTED]" });
      expect(event.requestBody).toBe('{"password":"[REDACTED]"}');
      expect(event.responseHeaders).toMatchObject({ authorization: "[REDACTED]" });
      expect(event.responseBody).toBe('{"access_token":"[REDACTED]","value":1}');
    } finally {
      bridge.disconnect();
      globalThis.fetch = previousFetch;
      if (previousSocket) Object.assign(globalRecord, { WebSocket: previousSocket });
      else delete globalRecord.WebSocket;
    }
  });
});
