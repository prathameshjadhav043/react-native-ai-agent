import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { DebugEventStore } from "../src/debugStore";
import { RuntimeBridgeServer } from "../src/runtimeServer";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

describe("local runtime bridge", () => {
  it("accepts token-authenticated runtime events and publishes a sanitized snapshot", async () => {
    const port = await freePort();
    const store = new DebugEventStore();
    const server = new RuntimeBridgeServer(store, "127.0.0.1", port);
    await server.start();
    try {
      const received = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for bridge event")), 3000);
        store.subscribe(snapshot => {
          if (snapshot.network.length) { clearTimeout(timer); resolve(); }
        });
      });
      const socket = new WebSocket(server.url);
      await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
      socket.send(JSON.stringify({ type: "network", method: "GET", url: "https://example.test/data?access_token=secret", status: 200, durationMs: 12, requestHeaders: { authorization: "secret" }, requestBody: "{\"password\":\"secret\"}", timestamp: 1 }));
      await received;
      expect(store.snapshot().network[0]).toMatchObject({ type: "network", method: "GET", status: 200, durationMs: 12 });
      expect(store.snapshot().network[0]).toMatchObject({ url: "https://example.test/data?access_token=%5BREDACTED%5D", requestHeaders: { authorization: "[REDACTED]" }, requestBody: "{\"password\":\"[REDACTED]\"}" });
      socket.close();
    } finally {
      await server.stop();
    }
  });
});
