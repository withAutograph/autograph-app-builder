import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAgentPluginPackage,
  validateAgentPluginPackage,
} from "./agent-plugin-package";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const portableEntries = ["plugin.json", "mcp.json", "skills", "LICENSE"];

const copyPortablePackage = async () => {
  const root = await mkdtemp(resolve(tmpdir(), "agent-plugin-package-"));
  for (const entry of portableEntries)
    await cp(resolve(repositoryRoot, entry), resolve(root, entry), {
      recursive: true,
    });
  return root;
};

const writeMcpHeaders = async (
  root: string,
  headers: Record<string, string>,
) => {
  const mcp = JSON.parse(
    await readFile(resolve(repositoryRoot, "mcp.json"), "utf8"),
  );
  mcp.mcpServers["autograph-app-builder"].headers = headers;
  await writeFile(resolve(root, "mcp.json"), JSON.stringify(mcp));
};

describe("Agent Plugins package", () => {
  it("builds and validates a client-neutral artifact", async () => {
    const output = resolve(
      repositoryRoot,
      ".artifacts/agent-plugin/autograph-app-builder-test",
    );
    await buildAgentPluginPackage({ repositoryRoot, outputRoot: output });
    await expect(
      validateAgentPluginPackage({
        pluginRoot: output,
        repositoryRoot,
        packageKind: "generated-artifact",
      }),
    ).resolves.toEqual({
      name: "autograph-app-builder",
      version: "1.0.0",
      packageKind: "generated-artifact",
    });
    await expect(
      readFile(resolve(output, "plugin.json"), "utf8"),
    ).resolves.toBe(
      await readFile(resolve(repositoryRoot, "plugin.json"), "utf8"),
    );
    await expect(
      readFile(resolve(output, ".codex-plugin/plugin.json")),
    ).rejects.toThrow();
    await expect(readFile(resolve(output, ".app.json"))).rejects.toThrow();
  });

  it("separates source validation from generated artifact conformance", async () => {
    await expect(
      validateAgentPluginPackage({
        pluginRoot: repositoryRoot,
        repositoryRoot,
        packageKind: "source",
      }),
    ).resolves.toMatchObject({ packageKind: "source" });
    await expect(
      validateAgentPluginPackage({
        pluginRoot: repositoryRoot,
        repositoryRoot,
        packageKind: "generated-artifact",
      }),
    ).rejects.toThrow("must contain exactly");
  });

  it("rejects a release package with the development endpoint", async () => {
    await expect(
      validateAgentPluginPackage({
        pluginRoot: repositoryRoot,
        repositoryRoot,
        release: true,
      }),
    ).rejects.toThrow("deployed HTTPS endpoint");
  });

  it("rejects package symlinks", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agent-plugin-link-"));
    await mkdir(resolve(root, "skills/eve-agent"), { recursive: true });
    await writeFile(
      resolve(root, "plugin.json"),
      await readFile(resolve(repositoryRoot, "plugin.json")),
    );
    await writeFile(
      resolve(root, "mcp.json"),
      await readFile(resolve(repositoryRoot, "mcp.json")),
    );
    await symlink(
      resolve(repositoryRoot, "skills/eve-agent/SKILL.md"),
      resolve(root, "skills/eve-agent/SKILL.md"),
    );
    await expect(
      validateAgentPluginPackage({ pluginRoot: root, repositoryRoot }),
    ).rejects.toThrow("regular file");
  });

  it("parses quoted and multiline Agent Skills frontmatter", async () => {
    const root = await copyPortablePackage();
    await writeFile(
      resolve(root, "skills/eve-agent/SKILL.md"),
      `---
name: "eve-agent"
description: >-
  Start and continue durable Eve sessions
  when app-building work needs orchestration.
license: "MIT"
compatibility: >-
  Requires a client that supports Agent Plugins skills and one supported MCP transport.
metadata:
  owner: "Autograph"
  version: "1.0"
allowed-tools: "eve_start eve_get"
---

# Eve agent orchestration
`,
    );
    await expect(
      validateAgentPluginPackage({ pluginRoot: root, repositoryRoot }),
    ).resolves.toMatchObject({ name: "autograph-app-builder" });
  });

  it.each([
    [
      "a skill name over 64 characters",
      `---\nname: ${"a".repeat(65)}\ndescription: valid\n---\n`,
      "at most 64 characters",
    ],
    [
      "an unsupported frontmatter field",
      "---\nname: eve-agent\ndescription: valid\nextra: value\n---\n",
      "unsupported frontmatter fields",
    ],
    [
      "a non-string optional field",
      "---\nname: eve-agent\ndescription: valid\nallowed-tools:\n  - eve_get\n---\n",
      "allowed-tools must be a string",
    ],
    [
      "duplicate YAML keys",
      "---\nname: eve-agent\nname: other\ndescription: valid\n---\n",
      "valid YAML mapping",
    ],
    [
      "overlong compatibility text",
      `---\nname: eve-agent\ndescription: valid\ncompatibility: ${"a".repeat(501)}\n---\n`,
      "at most 500 characters",
    ],
    [
      "non-string metadata values",
      "---\nname: eve-agent\ndescription: valid\nmetadata:\n  version: 1\n---\n",
      "metadata must map string keys to string values",
    ],
  ])("rejects %s", async (_name, skill, message) => {
    const root = await copyPortablePackage();
    await writeFile(resolve(root, "skills/eve-agent/SKILL.md"), skill);
    await expect(
      validateAgentPluginPackage({ pluginRoot: root, repositoryRoot }),
    ).rejects.toThrow(message);
  });

  it("accepts valid public declarative HTTP headers", async () => {
    const root = await copyPortablePackage();
    await writeMcpHeaders(root, {
      "X-Client-Name": "autograph-app-builder",
      "X-Public-Tenant": "public-tenant",
    });
    await expect(
      validateAgentPluginPackage({ pluginRoot: root, repositoryRoot }),
    ).resolves.toMatchObject({ name: "autograph-app-builder" });
  });

  it.each([
    [
      "invalid HTTP field names",
      { "bad header": "public" },
      "invalid HTTP header name",
    ],
    [
      "case-insensitive duplicate HTTP field names",
      { "X-Client": "public", "x-client": "public" },
      "with different casing",
    ],
    [
      "credential-bearing HTTP field names",
      { "X-Api-Key": "public" },
      "not demonstrably public",
    ],
    [
      "secret-like HTTP field values",
      { "X-Client": "${CLIENT_SECRET}" },
      "not demonstrably public",
    ],
    [
      "invalid HTTP field values",
      { "X-Client": "line one\nline two" },
      "invalid value",
    ],
  ])("rejects %s", async (_name, headers, message) => {
    const root = await copyPortablePackage();
    await writeMcpHeaders(root, headers);
    await expect(
      validateAgentPluginPackage({ pluginRoot: root, repositoryRoot }),
    ).rejects.toThrow(message);
  });

  it("rejects a linked artifact parent before removing output", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agent-plugin-output-"));
    const outside = await mkdtemp(resolve(tmpdir(), "agent-plugin-outside-"));
    for (const entry of portableEntries)
      await cp(resolve(repositoryRoot, entry), resolve(root, entry), {
        recursive: true,
      });
    await symlink(outside, resolve(root, ".artifacts"));
    await expect(
      buildAgentPluginPackage({
        repositoryRoot: root,
        outputRoot: resolve(
          root,
          ".artifacts/agent-plugin/autograph-app-builder",
        ),
      }),
    ).rejects.toThrow("must be a real directory");
  });
});
