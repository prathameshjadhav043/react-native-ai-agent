export type RuntimeEvent =
  | { type: "console"; level: "log" | "info" | "warn" | "error" | "debug"; message: string; timestamp: number; appName?: string }
  | { type: "network"; method: string; url: string; status?: number; durationMs: number; requestHeaders?: Record<string, string>; requestBody?: string; responseHeaders?: Record<string, string>; responseBody?: string; error?: string; timestamp: number; appName?: string }
  | { type: "error"; message: string; stack?: string; source?: string; timestamp: number; appName?: string }
  | { type: "performance"; name: string; value: number; unit?: string; timestamp: number; appName?: string };

export interface DebugSnapshot {
  console: RuntimeEvent[];
  network: RuntimeEvent[];
  errors: RuntimeEvent[];
  performance: RuntimeEvent[];
}

export interface PendingEdit {
  id: string;
  path: string;
  reason: string;
  originalContent: string;
  proposedContent: string;
  createdAt: number;
}
