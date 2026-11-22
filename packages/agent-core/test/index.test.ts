import { describe, expect, it } from "vitest";
import { getRefactoringRecommendations, indexArchitecture } from "../src/index";

describe("project architecture indexing", () => {
  it("finds screens, hooks and services from TypeScript files", () => {
    const index = indexArchitecture([
      { path: "src/HomeScreen.tsx", content: "export function HomeScreen() { return null; }" },
      { path: "src/hooks/useSession.ts", content: "export const useSession = () => null;" },
      { path: "src/api/userService.ts", content: "export class UserService {}" }
    ]);
    expect(index.files).toBe(3);
    expect(index.symbols.map(item => item.name)).toEqual(["HomeScreen", "useSession", "UserService"]);
    expect(index.byKind.hook).toBe(1);
  });

  it("suggests duplicate names and large files", () => {
    const files = [
      { path: "a.ts", content: "export function format() {}" },
      { path: "b.ts", content: `export function format() {}\n${Array(510).fill("// line").join("\n")}` }
    ];
    const index = indexArchitecture(files);
    const suggestions = getRefactoringRecommendations(files, index);
    expect(suggestions.some(item => item.includes("format"))).toBe(true);
    expect(suggestions.some(item => item.includes("b.ts"))).toBe(true);
  });
});
