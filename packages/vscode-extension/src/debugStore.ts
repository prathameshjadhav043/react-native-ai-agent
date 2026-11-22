import type { DebugSnapshot, RuntimeEvent } from "@rn-agent/shared";

const MAX_EVENTS = 500;

export class DebugEventStore {
  private readonly events: DebugSnapshot = { console: [], network: [], errors: [], performance: [] };
  private readonly listeners = new Set<(snapshot: DebugSnapshot) => void>();

  add(event: RuntimeEvent): void {
    const key = event.type === "error" ? "errors" : event.type;
    const list = this.events[key];
    list.push(event);
    if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS);
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  snapshot(): DebugSnapshot {
    return {
      console: [...this.events.console],
      network: [...this.events.network],
      errors: [...this.events.errors],
      performance: [...this.events.performance]
    };
  }

  subscribe(listener: (snapshot: DebugSnapshot) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
}
