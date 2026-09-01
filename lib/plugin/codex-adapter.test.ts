import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Codex adapter", () => {
  it("binds the installed plugin to the local Eve MCP runtime", async () => {
    const manifest = JSON.parse(
      await readFile(resolve(".codex-plugin/plugin.json"), "utf8"),
    );
    const mcp = JSON.parse(await readFile(resolve(".mcp.json"), "utf8"));
    const portableMcp = JSON.parse(await readFile(resolve("mcp.json"), "utf8"));

    expect(manifest.mcpServers).toBe("./.mcp.json");
    expect(manifest.apps).toBeUndefined();
    expect(mcp).toEqual({
      mcpServers: {
        "app-builder": {
          type: "http",
          url: "http://127.0.0.1:3000/mcp",
        },
      },
    });
    expect(portableMcp.mcpServers["app-builder"].url).toBe(
      "http://127.0.0.1:3000/mcp",
    );
    for (const prompt of manifest.interface.defaultPrompt) {
      expect(prompt.length).toBeLessThanOrEqual(128);
    }
    expect(manifest.interface.shortDescription).toBe(
      "Design and create apps with Autograph",
    );
    expect(manifest.interface.longDescription).toBe(
      "Use Autograph App Builder to design, plan, create, validate, and separately publish apps in explicitly supported repositories.",
    );
    expect(manifest.interface.logo).toBe("./assets/autograph-icon.png");
    expect(manifest.interface.composerIcon).toBe("./assets/autograph-icon.png");
    expect(manifest.interface.defaultPrompt.join(" ")).not.toContain(
      "App Builder session",
    );
  });

  it("fails closed instead of invoking another app builder", async () => {
    const skill = await readFile(
      resolve("skills/autograph-app-builder/SKILL.md"),
      "utf8",
    );

    for (const tool of [
      "autograph_start",
      "autograph_get",
      "autograph_send",
      "autograph_respond",
      "autograph_cancel",
    ]) {
      expect(skill).toContain(`\`${tool}\``);
    }
    expect(skill).toContain("Do not invoke another app-building skill");
    expect(skill).toContain("edit the target repository directly");
    expect(skill).toContain("# Autograph App Builder orchestration");
    expect(skill).toContain("Before starting an app build");
    expect(skill).toMatch(
      /Start genuinely new\s+work with `autograph_start\(\{ prompt, clientRequestId \}\)`/u,
    );
    expect(skill).toMatch(
      /call\s+`autograph_get` without a `sessionId` first/u,
    );
    expect(skill).toContain("Never split one App Builder batch across calls");
    expect(skill).toContain("Treat tool-only progress as silent");
    expect(skill).toContain("continue without a user-facing progress message");
    expect(skill).toMatch(
      /The\s+prototype and implementation plan are ready to review/u,
    );
    expect(skill).toMatch(
      /never that prototype or\s+plan receipts are pending or complete/u,
    );
    expect(skill).not.toContain("Before doing any app-building work");
    expect(skill).not.toContain("new app-building objective");
    expect(skill).not.toContain("# Eve agent orchestration");
  });
});
