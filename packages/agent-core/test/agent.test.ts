import { describe, expect, it, vi } from "vitest";
import { AgentEngine, type AssistantReply, type MemoryState, type WorkspaceAdapter } from "../src/index";

describe("agent tool approval flow", () => {
  it("stages proposed edits for approval and never applies them directly", async () => {
    const pending = { id: "edit-1", path: "src/App.tsx", reason: "Add a loading state", originalContent: "export default function App() {}", proposedContent: "export default function App() { return null; }", createdAt: 1 };
    const workspace: WorkspaceAdapter = {
      listFiles: async () => [], readFile: async () => "", search: async () => [],
      stageEdit: vi.fn(async () => pending)
    };
    let memory: MemoryState = { version: 1, notes: [] };
    const memoryStore = { load: async () => memory, save: async (next: MemoryState) => { memory = next; } };
    const replies: AssistantReply[] = [
      { content: "I will stage the change.", toolCalls: [{ id: "call-1", name: "propose_file_edit", arguments: JSON.stringify({ path: pending.path, content: pending.proposedContent, reason: pending.reason }) }] },
      { content: "The edit is ready for your review." }
    ];
    const provider = { complete: vi.fn(async () => replies.shift()!) };
    const onPendingEdit = vi.fn();
    const engine = new AgentEngine({ provider, workspace, memory: memoryStore, projectName: "Sample App", onPendingEdit });
    const result = await engine.chat("Add a loading state.");
    expect(workspace.stageEdit).toHaveBeenCalledOnce();
    expect(onPendingEdit).toHaveBeenCalledWith(pending);
    expect(result.answer).toContain("review");
    expect(provider.complete).toHaveBeenCalledTimes(2);
  });
});
