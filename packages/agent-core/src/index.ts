import ts from "typescript";
import type { PendingEdit } from "@rn-agent/shared";

export type ChatRole = "user" | "assistant";
export interface ConversationMessage { role: ChatRole; content: string }
export interface WorkspaceFile { path: string; updatedAt?: number }
export interface WorkspaceAdapter {
  listFiles(limit: number): Promise<WorkspaceFile[]>;
  readFile(path: string): Promise<string>;
  search(query: string, limit: number): Promise<Array<{ path: string; line: number; excerpt: string }>>;
  stageEdit(path: string, content: string, reason: string): Promise<PendingEdit>;
}
export interface MemoryNote { id: string; text: string; createdAt: number }
export interface MemoryState {
  version: 1;
  notes: MemoryNote[];
  architecture?: { signature: string; index: ArchitectureIndex };
}
export interface MemoryStore { load(): Promise<MemoryState>; save(state: MemoryState): Promise<void> }
export interface ChatCompletionTool { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface ToolCall { id: string; name: string; arguments: string }
export interface AssistantReply { content: string; toolCalls?: ToolCall[] }
export interface ChatProvider { complete(messages: Array<Record<string, unknown>>, tools: ChatCompletionTool[]): Promise<AssistantReply> }
export interface ArchitectureSymbol { name: string; kind: string; path: string; line: number }
export interface ArchitectureIndex { files: number; symbols: ArchitectureSymbol[]; byKind: Record<string, number>; generatedAt: number }

const textExtensions = /\.(tsx?|jsx?)$/i;
const defaultExclude = /(node_modules|\.git|\.expo|android\/|ios\/|build\/|dist\/|Pods\/|coverage\/)/i;

function classify(name: string, node: ts.Node): string {
  if (/screen|page/i.test(name)) return "screen";
  if (/^use[A-Z0-9]/.test(name)) return "hook";
  if (/service|client|api/i.test(name)) return "service";
  if (/store|slice|reducer/i.test(name)) return "state";
  if (/^[A-Z]/.test(name) && (ts.isFunctionLike(node) || ts.isClassLike(node))) return "component-or-class";
  return "function";
}

export function indexArchitecture(files: Array<{ path: string; content: string }>): ArchitectureIndex {
  const symbols: ArchitectureSymbol[] = [];
  for (const file of files) {
    if (!textExtensions.test(file.path) || defaultExclude.test(file.path)) continue;
    const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
    const record = (name: string, node: ts.Node) => {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      symbols.push({ name, kind: classify(name, node), path: file.path, line: line + 1 });
    };
    const visit = (node: ts.Node) => {
      if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) record(node.name.text, node);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) record(node.name.text, node);
      if (ts.isMethodDeclaration(node) && node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) record(node.name.text, node);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const byKind: Record<string, number> = {};
  for (const symbol of symbols) byKind[symbol.kind] = (byKind[symbol.kind] ?? 0) + 1;
  return { files: files.filter(f => textExtensions.test(f.path) && !defaultExclude.test(f.path)).length, symbols, byKind, generatedAt: Date.now() };
}

export function getRefactoringRecommendations(files: Array<{ path: string; content: string }>, index: ArchitectureIndex): string[] {
  const recommendations: string[] = [];
  const duplicates = new Map<string, ArchitectureSymbol[]>();
  for (const symbol of index.symbols) {
    const existing = duplicates.get(symbol.name) ?? [];
    existing.push(symbol);
    duplicates.set(symbol.name, existing);
  }
  for (const [name, items] of duplicates) {
    const paths = [...new Set(items.map(item => item.path))];
    if (paths.length > 1 && name.length > 3 && !["constructor", "render", "toString", "toJSON"].includes(name)) recommendations.push(`The symbol “${name}” appears in ${paths.length} files. Check whether a shared implementation would reduce duplication (${paths.slice(0, 3).join(", ")}).`);
  }
  for (const file of files) {
    const lines = file.content.split(/\r?\n/).length;
    if (lines > 500) recommendations.push(`${file.path} has ${lines} lines. Consider splitting it by screen, service, or component responsibility.`);
  }
  return recommendations.slice(0, 20);
}

const toolList: ChatCompletionTool[] = [
  { type: "function", function: { name: "search_workspace", description: "Search source files for text or identifiers.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "read_file", description: "Read a workspace file. Paths are relative to the project root.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } },
  { type: "function", function: { name: "get_project_architecture", description: "Index screens, components, hooks, services and state helpers in the project.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "search_reusable_code", description: "Find existing code that may be reused for the requested feature.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "get_refactoring_recommendations", description: "Review the project index and return lightweight refactoring suggestions.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "remember_note", description: "Save a durable project note for future chats.", parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"], additionalProperties: false } } },
  { type: "function", function: { name: "recall_memory", description: "Search saved project notes.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "propose_file_edit", description: "Stage a complete replacement for a workspace file. This does not modify the file; the developer must approve it in the chat.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, reason: { type: "string" } }, required: ["path", "content", "reason"], additionalProperties: false } } }
];

export interface AgentOptions {
  provider: ChatProvider;
  workspace: WorkspaceAdapter;
  memory: MemoryStore;
  projectName: string;
  onPendingEdit?: (edit: PendingEdit) => void;
  maxToolRounds?: number;
}

const systemPrompt = `You are the React Native AI Agent inside VS Code. Help implement and understand the open React Native project. Use tools to inspect existing architecture and reuse existing code before proposing new code. Be clear about assumptions. Never claim a file was changed unless the developer approved and applied a staged edit. For code changes call propose_file_edit; the extension will show a review action, and the user must approve it. Do not ask for secrets. Keep React Native and TypeScript conventions in the project.`;

export class AgentEngine {
  constructor(private readonly options: AgentOptions) {}

  async chat(userText: string, previous: ConversationMessage[] = []): Promise<{ answer: string; history: ConversationMessage[] }> {
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: `${systemPrompt}\nProject: ${this.options.projectName}` },
      ...previous.slice(-14).map(item => ({ role: item.role, content: item.content })),
      { role: "user", content: userText }
    ];
    let answer = "";
    for (let round = 0; round < (this.options.maxToolRounds ?? 8); round++) {
      const reply = await this.options.provider.complete(messages, toolList);
      answer = reply.content || answer;
      if (!reply.toolCalls?.length) break;
      messages.push({ role: "assistant", content: reply.content || null, tool_calls: reply.toolCalls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) });
      for (const call of reply.toolCalls) {
        let result: unknown;
        try { result = await this.executeTool(call.name, JSON.parse(call.arguments)); }
        catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
      if (round === (this.options.maxToolRounds ?? 8) - 1) answer += "\n\nI reached the tool-call limit for this turn. Please continue with a narrower request.";
    }
    const history = [...previous.slice(-14), { role: "user" as const, content: userText }, { role: "assistant" as const, content: answer }].slice(-16);
    return { answer: answer || "I couldn't produce a response. Check the configured AI provider and try again.", history };
  }

  async refreshArchitectureIndex(): Promise<ArchitectureIndex> {
    return (await this.createIndex(true)).index;
  }

  private async executeTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    const workspace = this.options.workspace;
    switch (name) {
      case "search_workspace":
        return workspace.search(String(input.query ?? ""), 24);
      case "read_file": {
        const content = await workspace.readFile(String(input.path ?? ""));
        return content.length > 30000 ? `${content.slice(0, 30000)}\n[truncated]` : content;
      }
      case "get_project_architecture":
        return (await this.createIndex()).index;
      case "search_reusable_code": {
        const query = String(input.query ?? "");
        const terms = [...new Set(query.split(/[^\p{L}\p{N}_-]+/u).filter(term => term.length > 2))].slice(0, 6);
        const matches = new Map<string, { path: string; line: number; excerpt: string }>();
        for (const term of terms) {
          for (const result of await workspace.search(term, 12)) matches.set(`${result.path}:${result.line}`, result);
          if (matches.size >= 30) break;
        }
        return [...matches.values()].slice(0, 30);
      }
      case "get_refactoring_recommendations": {
        const { files, index } = await this.createIndex();
        return getRefactoringRecommendations(files, index);
      }
      case "remember_note": {
        const state = await this.options.memory.load();
        const note = String(input.note ?? "").trim().slice(0, 2000);
        if (!note) throw new Error("A non-empty note is required.");
        const item = { id: crypto.randomUUID(), text: note, createdAt: Date.now() };
        state.notes = [...state.notes, item].slice(-200);
        await this.options.memory.save(state);
        return { saved: true, note: item };
      }
      case "recall_memory": {
        const state = await this.options.memory.load();
        const query = String(input.query ?? "").toLocaleLowerCase();
        return state.notes.filter(note => note.text.toLocaleLowerCase().includes(query)).slice(-20);
      }
      case "propose_file_edit": {
        const edit = await workspace.stageEdit(String(input.path ?? ""), String(input.content ?? ""), String(input.reason ?? ""));
        this.options.onPendingEdit?.(edit);
        return { staged: true, id: edit.id, path: edit.path, reason: edit.reason, approval: "Waiting for developer approval in VS Code." };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private async createIndex(force = false): Promise<{ files: Array<{ path: string; content: string }>; index: ArchitectureIndex }> {
    const listed = await this.options.workspace.listFiles(500);
    const sourceFiles = listed.filter(file => textExtensions.test(file.path) && !defaultExclude.test(file.path)).slice(0, 300);
    const signature = JSON.stringify(sourceFiles.map(file => [file.path, file.updatedAt ?? null]));
    const memory = await this.options.memory.load();
    let index = !force && memory.architecture?.signature === signature ? memory.architecture.index : undefined;
    const files: Array<{ path: string; content: string }> = [];
    let bytes = 0;
    for (const file of sourceFiles) {
      if (bytes >= 1_000_000) break;
      try {
        const content = await this.options.workspace.readFile(file.path);
        if (content.length > 100_000) continue;
        files.push({ path: file.path, content });
        bytes += content.length;
      } catch { /* A file may disappear between listing and reading. */ }
    }
    if (!index) {
      index = indexArchitecture(files);
      memory.architecture = { signature, index };
      await this.options.memory.save(memory);
    }
    return { files, index };
  }
}

export class OpenAICompatibleProvider implements ChatProvider {
  constructor(private readonly baseUrl: string, private readonly model: string, private readonly apiKey: string, private readonly request: typeof fetch = fetch) {}

  async complete(messages: Array<Record<string, unknown>>, tools: ChatCompletionTool[]): Promise<AssistantReply> {
    const base = this.baseUrl.replace(/\/$/, "");
    const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
    const response = await this.request(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, messages, tools, tool_choice: "auto" })
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 2000);
      throw new Error(`AI provider returned ${response.status}: ${detail}`);
    }
    const body = await response.json() as { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }> };
    const message = body.choices?.[0]?.message;
    if (!message) throw new Error("AI provider returned an empty response.");
    return { content: message.content ?? "", toolCalls: message.tool_calls?.map(call => ({ id: call.id, name: call.function.name, arguments: call.function.arguments })) };
  }
}
