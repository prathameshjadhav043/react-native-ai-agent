import * as vscode from "vscode";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { AgentEngine, OpenAICompatibleProvider } from "@rn-agent/agent-core";
import type { ConversationMessage } from "@rn-agent/agent-core";
import type { PendingEdit } from "@rn-agent/shared";
import { DebugEventStore } from "./debugStore";
import { RuntimeBridgeServer } from "./runtimeServer";
import { applyApprovedEdit, JsonFileMemoryStore, VscodeWorkspaceAdapter } from "./workspaceAdapter";
import { ChatWebviewProvider, DebugWebviewProvider } from "./webviewHost";

const secretKey = "rnAgent.provider.apiKey";
const debugStore = new DebugEventStore();
let bridgeServer: RuntimeBridgeServer | undefined;
let history: ConversationMessage[] = [];
let chatProvider: ChatWebviewProvider;
let extensionContext: vscode.ExtensionContext;
const pendingEdits = new Map<string, PendingEdit>();

function getProjectServices(): { workspace: VscodeWorkspaceAdapter; memory: JsonFileMemoryStore; projectName: string } | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  const digest = createHash("sha256").update(folder.uri.toString()).digest("hex").slice(0, 20);
  const memoryPath = join(extensionContext.globalStorageUri.fsPath, digest, "memory.json");
  return { workspace: new VscodeWorkspaceAdapter(folder), memory: new JsonFileMemoryStore(memoryPath), projectName: folder.name };
}

async function startBridge(): Promise<void> {
  await bridgeServer?.stop();
  bridgeServer = undefined;
  const configuration = vscode.workspace.getConfiguration("rnAgent.bridge");
  if (!configuration.get<boolean>("enabled", true)) return;
  const host = configuration.get<string>("host", "127.0.0.1");
  const port = configuration.get<number>("port", 43127);
  const server = new RuntimeBridgeServer(debugStore, host, port);
  try {
    await server.start();
    bridgeServer = server;
  } catch (error) {
    void vscode.window.showErrorMessage(`RN Agent runtime bridge could not start: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function showRuntimeSetup(): Promise<void> {
  const enabled = vscode.workspace.getConfiguration("rnAgent.bridge").get<boolean>("enabled", true);
  if (!enabled) {
    const choice = await vscode.window.showInformationMessage("The RN Agent runtime bridge is disabled in settings.", "Enable and restart");
    if (choice === "Enable and restart") {
      await vscode.workspace.getConfiguration("rnAgent.bridge").update("enabled", true, vscode.ConfigurationTarget.Workspace);
      await startBridge();
    } else return;
  } else if (!bridgeServer) await startBridge();

  if (!bridgeServer) return;
  const url = bridgeServer.url;
  const document = await vscode.workspace.openTextDocument({ language: "markdown", content: `# React Native runtime bridge setup\n\nThe local bridge is listening on **${vscode.workspace.getConfiguration("rnAgent.bridge").get("host", "127.0.0.1")}** port **${vscode.workspace.getConfiguration("rnAgent.bridge").get("port", 43127)}**. The token is private to this VS Code session.\n\nIn the React Native application, add the runtime bridge package and initialize it once near app startup:\n\n\`\`\`ts\nimport { connectReactNativeAgent } from "@rn-agent/runtime-bridge";\n\nconst agentBridge = connectReactNativeAgent({\n  url: "${url}",\n  appName: "My React Native App"\n});\n\n// Optional app-specific performance metric:\nagentBridge.reportPerformanceMetric("screen.startup", 245, "ms");\n\`\`\`\n\nFor Android Emulator, replace **127.0.0.1** in the URL with **10.0.2.2**. For a physical device, set **rnAgent.bridge.host** to **0.0.0.0**, connect the device to a trusted network, and use your Mac's LAN IP address in the URL. Keep the token private and remove the bridge from production builds.\n` });
  await vscode.window.showTextDocument(document, { preview: true });
}

async function setApiKey(): Promise<void> {
  const apiKey = await vscode.window.showInputBox({
    title: "React Native AI Agent API Key",
    prompt: "Enter the API key for the configured OpenAI-compatible provider. It is saved in VS Code SecretStorage.",
    password: true,
    ignoreFocusOut: true,
    validateInput: value => value.trim().length < 8 ? "Enter a valid API key." : undefined
  });
  if (!apiKey) return;
  await extensionContext.secrets.store(secretKey, apiKey.trim());
  void vscode.window.showInformationMessage("RN Agent API key saved securely.");
}

async function handleChat(text: string): Promise<void> {
  const prompt = text.trim();
  if (!prompt) return;
  const services = getProjectServices();
  if (!services) {
    chatProvider.addError("Open a React Native workspace folder before chatting.");
    return;
  }
  const apiKey = await extensionContext.secrets.get(secretKey);
  if (!apiKey) {
    chatProvider.addError("Set an API key to start. Use the API key button above or run RN Agent: Set API Key.");
    return;
  }
  chatProvider.setBusy(true);
  chatProvider.postUserMessage(prompt);
  try {
    const configuration = vscode.workspace.getConfiguration("rnAgent.provider");
    const provider = new OpenAICompatibleProvider(configuration.get<string>("baseUrl", "https://api.openai.com/v1"), configuration.get<string>("model", "gpt-4o-mini"), apiKey);
    const engine = new AgentEngine({
      provider,
      workspace: services.workspace,
      memory: services.memory,
      projectName: services.projectName,
      onPendingEdit: edit => { pendingEdits.set(edit.id, edit); chatProvider.addProposal(edit); }
    });
    const result = await engine.chat(prompt, history);
    history = result.history;
    chatProvider.postAgentMessage(result.answer);
    chatProvider.setHistory(history);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    chatProvider.addError(detail);
    void vscode.window.showErrorMessage(`RN Agent: ${detail}`);
  } finally {
    chatProvider.setBusy(false);
  }
}

async function runChatAction(type: string, id?: string): Promise<void> {
  if (type === "configure-key") await vscode.commands.executeCommand("rnAgent.setApiKey");
  if (type === "runtime-setup") await showRuntimeSetup();
  if (type === "apply-edit" && id) {
    const edit = pendingEdits.get(id);
    const services = getProjectServices();
    if (!edit || !services) return;
    try {
      await applyApprovedEdit(edit, services.workspace);
      pendingEdits.delete(id);
      chatProvider.removeProposal(id);
      void vscode.window.showInformationMessage(`Applied the proposed edit to ${edit.path}.`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      chatProvider.addError(detail);
      void vscode.window.showErrorMessage(`RN Agent could not apply the edit: ${detail}`);
    }
  }
  if (type === "reject-edit" && id) {
    pendingEdits.delete(id);
    chatProvider.removeProposal(id);
  }
}

async function rebuildIndex(): Promise<void> {
  const services = getProjectServices();
  if (!services) {
    void vscode.window.showWarningMessage("Open a project folder before rebuilding the architecture index.");
    return;
  }
  try {
    const engine = new AgentEngine({
      provider: { complete: async () => { throw new Error("No model call is needed to index a project."); } },
      workspace: services.workspace,
      memory: services.memory,
      projectName: services.projectName
    });
    const index = await engine.refreshArchitectureIndex();
    void vscode.window.showInformationMessage(`Indexed ${index.files} source files and ${index.symbols.length} architecture symbols.`);
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not index the project: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  chatProvider = new ChatWebviewProvider(context.extensionUri);
  chatProvider.onChat = handleChat;
  chatProvider.onAction = runChatAction;
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("rnAgent.chat", chatProvider, { webviewOptions: { retainContextWhenHidden: true } }));
  for (const [viewId, kind] of [["rnAgent.console", "console"], ["rnAgent.network", "network"], ["rnAgent.errors", "errors"], ["rnAgent.performance", "performance"]] as const) {
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(viewId, new DebugWebviewProvider(context.extensionUri, kind, debugStore), { webviewOptions: { retainContextWhenHidden: true } }));
  }
  context.subscriptions.push(
    vscode.commands.registerCommand("rnAgent.setApiKey", setApiKey),
    vscode.commands.registerCommand("rnAgent.clearApiKey", async () => { await context.secrets.delete(secretKey); void vscode.window.showInformationMessage("RN Agent API key removed."); }),
    vscode.commands.registerCommand("rnAgent.showRuntimeSetup", showRuntimeSetup),
    vscode.commands.registerCommand("rnAgent.rebuildArchitecture", rebuildIndex)
  );
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration("rnAgent.bridge")) void startBridge();
  }));
  void startBridge();
  context.subscriptions.push(new vscode.Disposable(() => { void bridgeServer?.stop(); }));
}

export function deactivate(): void {
  void bridgeServer?.stop();
}
