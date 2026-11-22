import type { RuntimeEvent } from "@rn-agent/shared";

export interface ReactNativeAgentBridgeOptions {
  url: string;
  appName?: string;
  reconnectDelayMs?: number;
  captureConsole?: boolean;
  captureNetwork?: boolean;
  captureErrors?: boolean;
}

export interface ReactNativeAgentBridge {
  reportPerformanceMetric(name: string, value: number, unit?: string): void;
  disconnect(): void;
}

const MAX_TEXT = 24_000;
const SECRET_KEY = /authorization|cookie|password|passwd|secret|token|api[-_]?key|credential/i;
const SECRET_TEXT = /("?(?:authorization|cookie|password|passwd|secret|access[_-]?token|refresh[_-]?token|api[-_]?key|credential)"?\s*[:=]\s*)("[^"\r\n]*"|[^,}\s&]+)/gi;

function clip(value: string): string {
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…[truncated]` : value.replace(SECRET_TEXT, (_match, prefix: string, secret: string) => `${prefix}${secret.startsWith('"') ? '"[REDACTED]"' : "[REDACTED]"}`);
}

function redactUrl(value: string): string {
  try {
    const parsed = new URL(value.replace(SECRET_TEXT, (_match, prefix: string, secret: string) => `${prefix}${secret.startsWith('"') ? '"[REDACTED]"' : "[REDACTED]"}`));
    for (const key of [...parsed.searchParams.keys()]) if (SECRET_KEY.test(key)) parsed.searchParams.set(key, "[REDACTED]");
    return parsed.toString().slice(0, MAX_TEXT);
  } catch { return clip(value); }
}

function safeSerialize(value: unknown, depth = 0): string {
  if (depth > 5) return "[max depth]";
  if (typeof value === "string") return clip(value);
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(value, (key, item: unknown) => {
      if (SECRET_KEY.test(key)) return "[REDACTED]";
      if (item && typeof item === "object") {
        if (seen.has(item as object)) return "[circular]";
        seen.add(item as object);
      }
      return item;
    });
    return clip(json ?? String(value));
  } catch { return clip(String(value)); }
}

function safeHeaders(input: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    const pairs: Array<[string, unknown]> = [];
    if (typeof Headers !== "undefined" && input instanceof Headers) input.forEach((value, key) => pairs.push([key, value]));
    else if (Array.isArray(input)) pairs.push(...input as Array<[string, unknown]>);
    else if (input && typeof input === "object") pairs.push(...Object.entries(input as Record<string, unknown>));
    for (const [key, value] of pairs) result[key] = SECRET_KEY.test(key) ? "[REDACTED]" : String(value).slice(0, 1000);
  } catch { /* Unsupported header shape; omit it. */ }
  return result;
}

function asUrl(value: unknown): string {
  try { return value instanceof Request ? value.url : String(value); } catch { return String(value); }
}

export function connectReactNativeAgent(options: ReactNativeAgentBridgeOptions): ReactNativeAgentBridge {
  const root = globalThis as typeof globalThis & { WebSocket?: typeof WebSocket; fetch?: typeof fetch; XMLHttpRequest?: typeof XMLHttpRequest; console: Console; addEventListener?: (type: string, listener: (event: any) => void) => void; removeEventListener?: (type: string, listener: (event: any) => void) => void };
  const Socket = root.WebSocket;
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const appName = options.appName ?? "React Native";
  const originals: Array<() => void> = [];

  const send = (event: RuntimeEvent) => {
    if (socket?.readyState === Socket?.OPEN) {
      try { socket.send(JSON.stringify({ ...event, appName })); } catch { /* A transient socket error should not affect the app. */ }
    }
  };
  const connect = () => {
    if (stopped || !Socket) return;
    try {
      socket = new Socket(options.url);
      socket.onclose = () => {
        if (!stopped) reconnectTimer = setTimeout(connect, options.reconnectDelayMs ?? 2500);
      };
      socket.onerror = () => { try { socket?.close(); } catch { /* ignored */ } };
    } catch {
      if (!stopped) reconnectTimer = setTimeout(connect, options.reconnectDelayMs ?? 2500);
    }
  };
  connect();

  if (options.captureConsole !== false) {
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      const original = root.console[level].bind(root.console);
      root.console[level] = ((...args: unknown[]) => {
        original(...args);
        send({ type: "console", level, message: args.map(value => safeSerialize(value)).join(" "), timestamp: Date.now() });
      }) as typeof root.console[typeof level];
      originals.push(() => { root.console[level] = original as typeof root.console[typeof level]; });
    }
  }

  if (options.captureErrors !== false) {
    const onError = (event: any) => send({ type: "error", message: String(event?.message ?? event?.reason ?? "Unhandled JavaScript error"), stack: String(event?.error?.stack ?? event?.reason?.stack ?? ""), source: event?.filename ? String(event.filename) : undefined, timestamp: Date.now() });
    root.addEventListener?.("error", onError);
    root.addEventListener?.("unhandledrejection", onError);
    originals.push(() => {
      root.removeEventListener?.("error", onError);
      root.removeEventListener?.("unhandledrejection", onError);
    });
  }

  if (options.captureNetwork !== false && root.fetch) {
    const originalFetch = root.fetch.bind(root);
    root.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = redactUrl(asUrl(input));
      const method = String(init?.method ?? (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET")).toUpperCase();
      const start = Date.now();
      let requestBody = typeof init?.body === "string" ? init.body : undefined;
      if (!requestBody && typeof Request !== "undefined" && input instanceof Request) {
        try { requestBody = await input.clone().text(); } catch { /* Body may not be readable. */ }
      }
      try {
        const response = await originalFetch(input, init);
        let responseBody = "";
        try { responseBody = await response.clone().text(); } catch { /* Native response body may not be cloneable. */ }
        send({ type: "network", method, url, status: response.status, durationMs: Date.now() - start, requestHeaders: safeHeaders(init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined)), requestBody: requestBody ? clip(requestBody) : undefined, responseHeaders: safeHeaders(response.headers), responseBody: clip(responseBody), timestamp: Date.now() });
        return response;
      } catch (error) {
        send({ type: "network", method, url, durationMs: Date.now() - start, requestHeaders: safeHeaders(init?.headers), requestBody: requestBody ? clip(requestBody) : undefined, error: String(error), timestamp: Date.now() });
        throw error;
      }
    }) as typeof fetch;
    originals.push(() => { root.fetch = originalFetch; });
  }

  const Xhr = root.XMLHttpRequest;
  if (options.captureNetwork !== false && Xhr?.prototype) {
    const proto = Xhr.prototype as XMLHttpRequest & { __rnAgent?: { open?: XMLHttpRequest["open"]; send?: XMLHttpRequest["send"]; setRequestHeader?: XMLHttpRequest["setRequestHeader"] } };
    const originalOpen = proto.open;
    const originalSend = proto.send;
    const originalSetHeader = proto.setRequestHeader;
    proto.open = function(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      (this as any).__rnAgentRequest = { method, url: redactUrl(String(url)), headers: {} as Record<string, string> };
      return (originalOpen as (...args: any[]) => void).apply(this, [method, url, ...rest]);
    } as typeof proto.open;
    proto.setRequestHeader = function(this: XMLHttpRequest, name: string, value: string) {
      const request = (this as any).__rnAgentRequest;
      if (request) request.headers[name] = SECRET_KEY.test(name) ? "[REDACTED]" : value;
      return originalSetHeader.call(this, name, value);
    };
    proto.send = function(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const request = (this as any).__rnAgentRequest ?? { method: "GET", url: "", headers: {} };
      const start = Date.now();
      this.addEventListener("loadend", () => {
        const headers: Record<string, string> = {};
        try { for (const row of this.getAllResponseHeaders().trim().split(/[\r\n]+/)) { const i = row.indexOf(":"); if (i > 0) headers[row.slice(0, i)] = row.slice(i + 1).trim(); } } catch { /* ignored */ }
        let responseBody = "";
        try { responseBody = String(this.responseText ?? ""); } catch { responseBody = "[non-text response]"; }
        send({ type: "network", method: String(request.method).toUpperCase(), url: String(request.url), status: this.status, durationMs: Date.now() - start, requestHeaders: request.headers, requestBody: typeof body === "string" ? clip(body) : undefined, responseHeaders: safeHeaders(headers), responseBody: clip(responseBody), timestamp: Date.now() });
      }, { once: true });
      return originalSend.call(this, body);
    };
    originals.push(() => { proto.open = originalOpen; proto.send = originalSend; proto.setRequestHeader = originalSetHeader; });
  }

  return {
    reportPerformanceMetric(name, value, unit) {
      if (!Number.isFinite(value)) return;
      send({ type: "performance", name: name.slice(0, 120), value, unit, timestamp: Date.now() });
    },
    disconnect() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { socket?.close(); } catch { /* ignored */ }
      for (const restore of originals.reverse()) restore();
    }
  };
}
