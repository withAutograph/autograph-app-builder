import { describe, expect, it } from "vitest";
import { buildAppHandoffPrompt } from "./client";

const handoffId = "11111111-1111-4111-8111-111111111111";

describe("destination-specific handoff setup", () => {
  it("preserves automatic official Codex setup without reinstalling working tools", () => {
    const prompt = buildAppHandoffPrompt(handoffId, "codex");
    expect(prompt).toContain("Do not reinstall or upgrade a working plugin");
    expect(prompt).toContain("install or update it automatically");
    expect(prompt).toContain("run the necessary commands yourself");
    expect(prompt).toContain("subject to native client approval requirements");
    expect(prompt).toContain("enable Autograph App Builder, and reopen this prepared app");
    expect(prompt).toContain("codex mcp login app-builder");
    expect(prompt).toContain("until it reports success");
    expect(prompt).toContain("Do not ask the user to run installation");
    expect(prompt).toContain("Never claim the handoff has started until autograph_start succeeds");
    expect(prompt).toContain(`"clientRequestId":"web-handoff:${handoffId}"`);
    expect(prompt).toContain("does not approve building, publishing, or deploying");
  });

  it("keeps Codex setup commands out of Cursor and retains the same start identity", () => {
    const prompt = buildAppHandoffPrompt(handoffId, "cursor");
    expect(prompt).not.toContain("codex plugin");
    expect(prompt).not.toContain("codex mcp login");
    expect(prompt).not.toContain("install or update it automatically");
    expect(prompt).toContain("Add Autograph to Cursor");
    expect(prompt).toContain(`"clientRequestId":"web-handoff:${handoffId}"`);
    expect(prompt).toContain("Do not request provider tokens or separate provider logins");
  });
});
