import { randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { RuntimeEvent } from "@rn-agent/shared";
import { DebugEventStore } from "./debugStore";

function limited(value: unknown, max = 24_000): string | undefined {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

const secretKey = /authorization|cookie|password|passwd|secret|token|api[-_]?key|credential/i;
const secretText = /("?(?:authorization|cookie|password|passwd|secret|access[_-]?token|refresh[_-]?token|api[-_]?key|credential)"?\s*[:=]\s*)("[^"\r\n]*"|[^,}\s&]+)/gi;

function redact(value: string): string {
  return value.replace(secretText, (_match, prefix: string, secret: string) => `${prefix}${secret.startsWith('"') ? '"[REDACTED]"' : "[REDACTED]"}`);
}

function redactUrl(value: string): string {
  try {
    const url = new URL(redact(value));
    for (const key of [...url.searchParams.keys()]) if (secretKey.test(key)) url.searchParams.set(key, "[REDACTED]");
    return url.toString().slice(0, 4000);
  } catch { return redact(value).slice(0, 4000); }
}

function normalizeEvent(input: unknown): RuntimeEvent | undefined {
  if (!input || typeof input !== "object") return undefined;
  const item = input as Record<string, unknown>;
  const timestamp = typeof item.timestamp === "number" && Number.isFinite(item.timestamp) ? item.timestamp : Date.now();
  const appName = limited(item.appName, 120);
  if (item.type === "console" && ["log", "info", "warn", "error", "debug"].includes(String(item.level))) {
    return { type: "console", level: item.level as "log" | "info" | "warn" | "error" | "debug", message: redact(limited(item.message) ?? ""), timestamp, appName };
  }
  if (item.type === "error") return { type: "error", message: redact(limited(item.message) ?? "Unknown error"), stack: item.stack ? redact(limited(item.stack) ?? "") : undefined, source: limited(item.source, 1000), timestamp, appName };
  if (item.type === "performance" && typeof item.name === "string" && typeof item.value === "number" && Number.isFinite(item.value)) {
    return { type: "performance", name: item.name.slice(0, 120), value: item.value, unit: limited(item.unit, 32), timestamp, appName };
  }
  if (item.type === "network") {
    const headers = (value: unknown) => value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 80).map(([key, val]) => [key.slice(0, 120), secretKey.test(key) ? "[REDACTED]" : redact(String(val).slice(0, 1000))])) : undefined;
    return {
      type: "network", method: limited(item.method, 24) ?? "GET", url: redactUrl(limited(item.url, 4000) ?? ""), status: typeof item.status === "number" ? item.status : undefined,
      durationMs: typeof item.durationMs === "number" && Number.isFinite(item.durationMs) ? Math.max(0, item.durationMs) : 0,
      requestHeaders: headers(item.requestHeaders), requestBody: item.requestBody ? redact(limited(item.requestBody) ?? "") : undefined, responseHeaders: headers(item.responseHeaders), responseBody: item.responseBody ? redact(limited(item.responseBody) ?? "") : undefined, error: item.error ? redact(limited(item.error, 2000) ?? "") : undefined, timestamp, appName
    };
  }
  return undefined;
}

export class RuntimeBridgeServer {
  readonly token = randomBytes(24).toString("hex");
  private server?: WebSocketServer;

  constructor(private readonly store: DebugEventStore, private readonly host: string, private readonly port: number) {}

  start(): Promise<void> {
    if (this.server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const server = new WebSocketServer({ host: this.host, port: this.port, maxPayload: 160_000, perMessageDeflate: false });
      this.server = server;
      server.once("listening", () => resolve());
      server.once("error", error => { this.server = undefined; reject(error); });
      server.on("connection", (socket, request) => {
        const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
        const supplied = requestUrl.searchParams.get("token") ?? "";
        const expected = Buffer.from(this.token);
        const received = Buffer.from(supplied);
        if (received.length !== expected.length || !timingSafeEqual(received, expected) || requestUrl.pathname !== "/rn-agent") {
          socket.close(1008, "Unauthorized");
          return;
        }
        socket.on("message", data => {
          try {
            const parsed = JSON.parse(data.toString()) as unknown;
            const normalized = normalizeEvent(parsed);
            if (normalized) this.store.add(normalized);
          } catch { /* Ignore malformed events from the bridge. */ }
        });
      });
    });
  }

  get url(): string { return `ws://${this.host === "0.0.0.0" ? "127.0.0.1" : this.host}:${this.port}/rn-agent?token=${this.token}`; }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    for (const client of server.clients) client.close(1001, "Extension deactivated");
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
