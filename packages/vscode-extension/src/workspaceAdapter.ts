import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { PendingEdit } from "@rn-agent/shared";
import type { MemoryState, MemoryStore, WorkspaceAdapter, WorkspaceFile } from "@rn-agent/agent-core";

const include = "**/*.{ts,tsx,js,jsx,json,md,yml,yaml}";
const exclude = "**/{node_modules,.git,.expo,Pods,build,dist,coverage,.next}/**,**/.env*,**/*.pem,**/*.key,**/secrets/**,**/.npmrc";
const defaultMemory: MemoryState = { version: 1, notes: [] };

export class VscodeWorkspaceAdapter implements WorkspaceAdapter {
  constructor(private readonly folder: vscode.WorkspaceFolder) {}

  private fileUri(path: string): vscode.Uri {
    const normalizedPath = path.replace(/\\/g, "/");
    if (/(^|\/)\.env[^/]*($|\/)|\.(pem|key)($|\/)|(^|\/)secrets?($|\/)|(^|\/)\.npmrc($|\/)/i.test(normalizedPath)) throw new Error("Access to credential and secret files is blocked.");
    const root = resolve(this.folder.uri.fsPath);
    const candidate = isAbsolute(path) ? resolve(path) : resolve(root, path);
    const relativePath = relative(root, candidate);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new Error("That path is outside the open workspace.");
    return vscode.Uri.file(candidate);
  }

  async listFiles(limit: number): Promise<WorkspaceFile[]> {
    const uris = await vscode.workspace.findFiles(include, exclude, limit);
    const files: WorkspaceFile[] = [];
    for (const uri of uris) {
      const relativePath = relative(this.folder.uri.fsPath, uri.fsPath);
      if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) continue;
      const path = relativePath.split(sep).join("/");
      try { const stat = await vscode.workspace.fs.stat(uri); files.push({ path, updatedAt: stat.mtime }); }
      catch { files.push({ path }); }
    }
    return files;
  }

  async readFile(path: string): Promise<string> {
    const content = await vscode.workspace.fs.readFile(this.fileUri(path));
    if (content.byteLength > 256_000) throw new Error("The requested file is larger than 256 KB.");
    return Buffer.from(content).toString("utf8");
  }

  async search(query: string, limit: number): Promise<Array<{ path: string; line: number; excerpt: string }>> {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return [];
    const files = await this.listFiles(400);
    const results: Array<{ path: string; line: number; excerpt: string }> = [];
    for (const file of files) {
      if (results.length >= limit) break;
      let content: string;
      try { content = await this.readFile(file.path); } catch { continue; }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length && results.length < limit; i++) {
        if (lines[i].toLocaleLowerCase().includes(needle)) results.push({ path: file.path, line: i + 1, excerpt: lines[i].slice(0, 500) });
      }
    }
    return results;
  }

  async stageEdit(path: string, content: string, reason: string): Promise<PendingEdit> {
    const uri = this.fileUri(path);
    let originalContent = "";
    try { originalContent = await this.readFile(path); }
    catch (error) {
      if (!(error instanceof vscode.FileSystemError) || error.code !== "FileNotFound") throw error;
    }
    if (content.length > 256_000) throw new Error("The proposed file exceeds the 256 KB edit limit.");
    return { id: randomUUID(), path: relative(this.folder.uri.fsPath, uri.fsPath).split(sep).join("/"), reason: reason.slice(0, 1000), originalContent, proposedContent: content, createdAt: Date.now() };
  }
}

export class JsonFileMemoryStore implements MemoryStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<MemoryState> {
    try {
      const value = JSON.parse(await (await import("node:fs/promises")).readFile(this.filePath, "utf8")) as MemoryState;
      if (value?.version === 1 && Array.isArray(value.notes)) return value;
    } catch { /* No memory saved yet or the file is unreadable. */ }
    return { ...defaultMemory };
  }

  async save(state: MemoryState): Promise<void> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(temp, this.filePath);
  }
}

export async function applyApprovedEdit(edit: PendingEdit, adapter: VscodeWorkspaceAdapter): Promise<void> {
  const current = await adapter.readFile(edit.path).catch(error => {
    if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") return "";
    throw error;
  });
  if (current !== edit.originalContent) throw new Error("The file changed after this proposal was created. Ask the agent to review the updated file and propose the edit again.");
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error("Open a workspace folder before applying edits.");
  const uri = vscode.Uri.joinPath(folder.uri, ...edit.path.split("/"));
  const workspaceEdit = new vscode.WorkspaceEdit();
  const exists = await vscode.workspace.fs.stat(uri).then(() => true, () => false);
  if (!exists) {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirname(uri.fsPath)));
    workspaceEdit.createFile(uri, { ignoreIfExists: false });
    workspaceEdit.insert(uri, new vscode.Position(0, 0), edit.proposedContent);
  } else {
    const document = await vscode.workspace.openTextDocument(uri);
    const end = document.positionAt(document.getText().length);
    workspaceEdit.replace(uri, new vscode.Range(new vscode.Position(0, 0), end), edit.proposedContent);
  }
  if (!await vscode.workspace.applyEdit(workspaceEdit)) throw new Error("VS Code could not apply the approved edit.");
}
