import type { ConversationMessage } from "@rn-agent/agent-core";
import type { PendingEdit, RuntimeEvent } from "@rn-agent/shared";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): unknown; setState(state: unknown): void };
const vscode = acquireVsCodeApi();
const root = document.getElementById("root")!;
const view = root.dataset.view ?? "";

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function time(timestamp: number): string {
  try { return new Date(timestamp).toLocaleTimeString(); } catch { return ""; }
}

function renderChat(): void {
  root.replaceChildren();
  const top = element("div", "top");
  top.append(element("strong", undefined, "React Native AI Agent"));
  const keyButton = element("button", "secondary", "API key"); keyButton.type = "button"; keyButton.onclick = () => vscode.postMessage({ type: "configure-key" }); top.append(keyButton);
  const setup = element("button", "secondary", "Bridge setup"); setup.type = "button"; setup.onclick = () => vscode.postMessage({ type: "runtime-setup" }); top.append(setup);
  root.append(top);
  const messages = element("section", "messages"); messages.id = "messages"; root.append(messages);
  const status = element("div", "status"); status.id = "status"; root.append(status);
  const composer = element("form", "composer");
  const input = element("textarea"); input.id = "prompt"; input.placeholder = "Ask about your React Native project…"; composer.append(input);
  const actions = element("div", "actions");
  const hint = element("span", "status", "Edits require your approval."); actions.append(hint);
  const send = element("button", "button", "Send"); send.type = "submit"; actions.append(send); composer.append(actions);
  composer.onsubmit = event => { event.preventDefault(); const text = input.value.trim(); if (!text) return; vscode.postMessage({ type: "chat", text }); input.value = ""; };
  root.append(composer);
}

function addChatMessage(role: string, content: string, className = ""): void {
  const messages = document.getElementById("messages"); if (!messages) return;
  const box = element("article", `message ${role} ${className}`.trim());
  box.append(element("div", "role", role === "user" ? "You" : role === "assistant" ? "RN Agent" : "Error"));
  box.append(element("div", undefined, content)); messages.append(box); messages.scrollTop = messages.scrollHeight;
}

function addProposal(edit: PendingEdit): void {
  const messages = document.getElementById("messages"); if (!messages) return;
  const box = element("section", "proposal"); box.dataset.proposalId = edit.id;
  box.append(element("strong", undefined, `Review edit: ${edit.path}`));
  box.append(element("p", "status", edit.reason));
  const details = element("details");
  details.append(element("summary", undefined, "Show proposed diff"));
  const preview = element("pre"); preview.textContent = diffPreview(edit); details.append(preview); box.append(details);
  const actions = element("div", "proposal-actions");
  const approve = element("button", "button", "Apply edit"); approve.type = "button"; approve.onclick = () => vscode.postMessage({ type: "apply-edit", id: edit.id }); actions.append(approve);
  const reject = element("button", "secondary", "Reject"); reject.type = "button"; reject.onclick = () => vscode.postMessage({ type: "reject-edit", id: edit.id }); actions.append(reject);
  box.append(actions); messages.append(box);
}

function diffPreview(edit: PendingEdit): string {
  const before = edit.originalContent.split(/\r?\n/);
  const after = edit.proposedContent.split(/\r?\n/);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const output = [`@@ ${edit.path} @@`];
  for (const line of before.slice(Math.max(0, prefix - 3), prefix)) output.push(`  ${line}`);
  for (const line of before.slice(prefix, before.length - suffix)) output.push(`- ${line}`);
  for (const line of after.slice(prefix, after.length - suffix)) output.push(`+ ${line}`);
  for (const line of after.slice(after.length - suffix, Math.min(after.length, after.length - suffix + 3))) output.push(`  ${line}`);
  if (output.length === 1) output.push("(no content changes)");
  const preview = output.join("\n");
  return preview.length > 24000 ? `${preview.slice(0, 24000)}\n[diff preview truncated]` : preview;
}

function renderDebug(events: RuntimeEvent[]): void {
  root.replaceChildren();
  const heading = element("div", "top"); heading.append(element("strong", undefined, view === "console" ? "React Native Console" : view === "network" ? "Network Requests" : view === "errors" ? "JavaScript Errors" : "Performance"));
  heading.append(element("span", "status", `${events.length} events`)); root.append(heading);
  if (!events.length) { root.append(element("div", "empty", "Waiting for React Native runtime events. Run RN Agent: Show Runtime Bridge Setup to connect an app.")); return; }
  const table = element("table");
  const body = element("tbody");
  if (view === "network") {
    const head = element("thead"); const row = element("tr");
    for (const label of ["Time", "Method", "URL", "Status", "Duration"]) row.append(element("th", undefined, label)); head.append(row); table.append(head);
    for (const event of [...events].reverse()) {
      if (event.type !== "network") continue;
      const tr = element("tr");
      for (const value of [time(event.timestamp), event.method, event.url, event.status === undefined ? event.error ?? "Failed" : String(event.status), `${event.durationMs} ms`]) tr.append(element("td", undefined, value));
      const detailRow = element("tr"); const cell = element("td"); cell.colSpan = 5;
      const detail = element("details"); const summary = element("summary", undefined, "Request and response details"); detail.append(summary);
      const dump = [event.requestHeaders && `Request headers\n${JSON.stringify(event.requestHeaders, null, 2)}`, event.requestBody && `Request body\n${event.requestBody}`, event.responseHeaders && `Response headers\n${JSON.stringify(event.responseHeaders, null, 2)}`, event.responseBody && `Response body\n${event.responseBody}`, event.error && `Error\n${event.error}`].filter(Boolean).join("\n\n");
      detail.append(element("pre", "row-detail", dump)); cell.append(detail); detailRow.append(cell); body.append(tr, detailRow);
    }
  } else if (view === "console") {
    const head = element("thead"); const row = element("tr"); for (const label of ["Time", "Level", "Message"]) row.append(element("th", undefined, label)); head.append(row); table.append(head);
    for (const event of [...events].reverse()) { if (event.type !== "console") continue; const tr = element("tr"); for (const value of [time(event.timestamp), event.level, event.message]) tr.append(element("td", undefined, value)); body.append(tr); }
  } else if (view === "errors") {
    const head = element("thead"); const row = element("tr"); for (const label of ["Time", "Error", "Source / stack"]) row.append(element("th", undefined, label)); head.append(row); table.append(head);
    for (const event of [...events].reverse()) { if (event.type !== "error") continue; const tr = element("tr"); for (const value of [time(event.timestamp), event.message, [event.source, event.stack].filter(Boolean).join("\n")]) tr.append(element("td", undefined, value)); body.append(tr); }
  } else {
    const head = element("thead"); const row = element("tr"); for (const label of ["Time", "Metric", "Value"]) row.append(element("th", undefined, label)); head.append(row); table.append(head);
    for (const event of [...events].reverse()) { if (event.type !== "performance") continue; const tr = element("tr"); for (const value of [time(event.timestamp), event.name, `${event.value} ${event.unit ?? ""}`]) tr.append(element("td", undefined, value)); body.append(tr); }
  }
  table.append(body); root.append(table);
}

if (view === "chat") renderChat();
window.addEventListener("message", event => {
  const message = event.data;
  if (view === "chat") {
    if (message.type === "initialize" || message.type === "history") {
      const items = message.history as ConversationMessage[];
      const container = document.getElementById("messages"); if (container) container.replaceChildren();
      for (const item of items ?? []) addChatMessage(item.role, item.content);
      for (const edit of message.proposals ?? []) addProposal(edit);
    } else if (message.type === "proposal") addProposal(message.edit as PendingEdit);
    else if (message.type === "remove-proposal") document.querySelector(`[data-proposal-id="${CSS.escape(message.id)}"]`)?.remove();
    else if (message.type === "busy") { const status = document.getElementById("status"); if (status) status.textContent = message.busy ? "Thinking…" : "Ready"; }
    else if (message.type === "chat-error") addChatMessage("error", String(message.error), "error");
    else if (message.type === "user-message") addChatMessage("user", String(message.text));
    else if (message.type === "agent-message") addChatMessage("assistant", String(message.text));
  } else if (message.type === "snapshot") renderDebug(message.events as RuntimeEvent[]);
});
