import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import type { DebugSnapshot, PendingEdit } from "@rn-agent/shared";
import type { ConversationMessage } from "@rn-agent/agent-core";
import { DebugEventStore } from "./debugStore";

export type ChatRequest = (text: string) => Promise<void>;
export type WebviewAction = (type: string, id?: string) => Promise<void> | void;

function htmlFor(webview: vscode.Webview, extensionUri: vscode.Uri, viewId: string): string {
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.js"));
  const nonce = randomBytes(18).toString("base64");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}; img-src ${webview.cspSource} data:;">
<title>React Native Agent</title><style>
:root{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-sideBar-background)}*{box-sizing:border-box}body{padding:0;margin:0}.root{padding:12px;display:flex;flex-direction:column;gap:10px;min-height:100vh}.top{display:flex;gap:6px;align-items:center}.top strong{flex:1}.button{font:inherit;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;border-radius:3px;padding:5px 9px;cursor:pointer}.button:hover{background:var(--vscode-button-hoverBackground)}.secondary{font:inherit;color:var(--vscode-foreground);background:var(--vscode-button-secondaryBackground);border:0;border-radius:3px;padding:5px 8px;cursor:pointer}.status{color:var(--vscode-descriptionForeground);font-size:.9em}.messages{display:flex;flex-direction:column;gap:10px;flex:1}.message{border-left:2px solid var(--vscode-focusBorder);padding:7px 9px;background:var(--vscode-editor-background);border-radius:2px;white-space:pre-wrap;overflow-wrap:anywhere}.message.user{border-color:var(--vscode-textLink-foreground)}.message.error{border-color:var(--vscode-errorForeground);color:var(--vscode-errorForeground)}.role{font-size:.8em;color:var(--vscode-descriptionForeground);margin-bottom:4px}.composer{display:flex;flex-direction:column;gap:7px;position:sticky;bottom:0;background:var(--vscode-sideBar-background);padding-top:4px}textarea{width:100%;min-height:76px;resize:vertical;font:inherit;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));padding:8px;border-radius:3px}.actions{display:flex;justify-content:space-between;gap:6px}.proposal{border:1px solid var(--vscode-panel-border);padding:8px;border-radius:3px;background:var(--vscode-editor-background)}.proposal pre{max-height:240px;overflow:auto;white-space:pre-wrap;font-size:.88em}.proposal-actions{display:flex;gap:7px}.toolbar{display:flex;gap:5px;flex-wrap:wrap}table{border-collapse:collapse;width:100%;font-size:.9em}th,td{text-align:left;border-bottom:1px solid var(--vscode-panel-border);padding:6px 4px;vertical-align:top;overflow-wrap:anywhere}th{color:var(--vscode-descriptionForeground);position:sticky;top:0;background:var(--vscode-sideBar-background)}.row-detail{color:var(--vscode-descriptionForeground);white-space:pre-wrap;max-width:600px}.empty{padding:16px;color:var(--vscode-descriptionForeground);text-align:center}.tag{display:inline-block;border:1px solid var(--vscode-panel-border);border-radius:10px;padding:1px 7px;margin-right:5px;font-size:.85em}
</style></head><body><main class="root" id="root" data-view="${viewId}"></main><script nonce="${nonce}" src="${script}"></script></body></html>`;
}

export class ChatWebviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private history: ConversationMessage[] = [];
  private proposals: PendingEdit[] = [];
  onChat?: ChatRequest;
  onAction?: WebviewAction;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")] };
    view.webview.html = htmlFor(view.webview, this.extensionUri, "chat");
    view.webview.onDidReceiveMessage(async message => {
      if (message?.type === "chat" && typeof message.text === "string") await this.onChat?.(message.text);
      else if (typeof message?.type === "string") await this.onAction?.(message.type, typeof message.id === "string" ? message.id : undefined);
    });
    this.post({ type: "initialize", history: this.history, proposals: this.proposals });
  }

  setHistory(history: ConversationMessage[]): void { this.history = history; this.post({ type: "history", history, proposals: this.proposals }); }
  addProposal(edit: PendingEdit): void { this.proposals = [...this.proposals.filter(item => item.id !== edit.id), edit]; this.post({ type: "proposal", edit }); }
  removeProposal(id: string): void { this.proposals = this.proposals.filter(item => item.id !== id); this.post({ type: "remove-proposal", id }); }
  setBusy(busy: boolean): void { this.post({ type: "busy", busy }); }
  addError(error: string): void { this.post({ type: "chat-error", error }); }
  postUserMessage(text: string): void { this.post({ type: "user-message", text }); }
  postAgentMessage(text: string): void { this.post({ type: "agent-message", text }); }
  private post(message: unknown): void { void this.view?.webview.postMessage(message); }
}

type DebugViewKind = "console" | "network" | "errors" | "performance";

export class DebugWebviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private subscription?: { dispose(): void };

  constructor(private readonly extensionUri: vscode.Uri, private readonly kind: DebugViewKind, private readonly store: DebugEventStore) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")] };
    view.webview.html = htmlFor(view.webview, this.extensionUri, this.kind);
    const post = (snapshot: DebugSnapshot) => void view.webview.postMessage({ type: "snapshot", kind: this.kind, events: snapshot[this.kind] });
    post(this.store.snapshot());
    this.subscription?.dispose();
    this.subscription = this.store.subscribe(post);
    view.onDidDispose(() => { this.subscription?.dispose(); this.subscription = undefined; this.view = undefined; });
  }
}
