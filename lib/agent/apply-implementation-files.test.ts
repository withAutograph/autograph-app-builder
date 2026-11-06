import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SandboxSession } from "eve/sandbox";

import {
  assertExistingAppImplementationFiles,
  implementationArchitectureDiagnostics,
  implementationFilesSchema,
  applyImplementationFiles,
  withImplementationFiles,
} from "./apply-implementation-files";
import { targetProposalSchema } from "../repository/target-planning";

const existingAppProposal = (appId: string) => {
  const workspacePath = `apps/${appId}`;
  const changes = [
    {
      after: { content: "", digest: "a".repeat(64), mode: "0644" },
      path: `${workspacePath}/app/page.tsx`,
    },
  ];
  return targetProposalSchema.parse({
    blockers: [],
    contract: {
      appId,
      appSpec: { path: `${workspacePath}/app-spec.md`, sha256: "a".repeat(64) },
      version: 1,
    },
    iteration: {
      changes,
      digest: createHash("sha256").update(JSON.stringify(changes)).digest("hex"),
    },
    mutations: [],
    operation: "iterate-existing-app",
    plan: {
      product: { appSpec: { path: `${workspacePath}/app-spec.md`, sha256: "a".repeat(64) } },
      source: {
        packageName: `@example/${appId}`,
        runtime: "nextjs",
        schema: { kind: "none" },
        workspacePath,
      },
      topology: {
        configPath: "microfrontends.json",
        packageName: `@example/${appId}`,
        projectName: appId,
        routes: [`/${appId}`],
      },
    },
  });
};

const sandboxFixture = (writeTextFile: SandboxSession["writeTextFile"]): SandboxSession => ({
  readBinaryFile: vi.fn<SandboxSession["readBinaryFile"]>(),
  readFile: vi.fn<SandboxSession["readFile"]>(),
  readTextFile: vi.fn<SandboxSession["readTextFile"]>(),
  removePath: vi.fn<SandboxSession["removePath"]>(),
  resolvePath: (path) => path,
  run: vi.fn<SandboxSession["run"]>(),
  spawn: vi.fn<SandboxSession["spawn"]>(),
  writeBinaryFile: vi.fn<SandboxSession["writeBinaryFile"]>(),
  writeFile: vi.fn<SandboxSession["writeFile"]>(),
  writeTextFile,
});

describe("approval-bound implementation files", () => {
  it("writes validated files into the successful apply overlay only", async () => {
    const files = implementationFilesSchema.parse([
      {
        content: "export default null",
        path: "apps/stock-exceptions/app/page.tsx",
      },
      {
        content: "export async function POST() { return Response.json({ saved: true }); }",
        path: "apps/stock-exceptions/app/api/drafts/route.ts",
      },
      { content: "export const worker = true;", path: "apps/stock-exceptions/server/worker.mts" },
      {
        content: "CREATE TABLE drafts (id text PRIMARY KEY);",
        path: "apps/stock-exceptions/db/migrations/001.sql",
      },
    ]);
    const writeTextFile = vi.fn<SandboxSession["writeTextFile"]>();
    const executor = vi.fn(async () => {
      await Promise.resolve();
      return {
        exitCode: 0,
        stderr: "",
        stdout: "receipt",
      };
    });
    const wrapped = withImplementationFiles(executor, files);

    await expect(
      wrapped({
        appId: "stock-exceptions",
        applyRoot: "/workspace/repository",
        proposal: existingAppProposal("stock-exceptions"),
        // SAFETY: This path only calls writeTextFile, which the test double provides.
        sandbox: sandboxFixture(writeTextFile),
      }),
    ).resolves.toEqual({ exitCode: 0, stderr: "", stdout: "receipt" });

    expect(writeTextFile).toHaveBeenCalledWith({
      content: "export default null",
      path: "repository/apps/stock-exceptions/app/page.tsx",
    });
    for (const [index, file] of files.entries()) {
      expect(writeTextFile).toHaveBeenNthCalledWith(index + 1, {
        content: file.content,
        path: `repository/${file.path}`,
      });
    }
    expect(
      implementationFilesSchema.safeParse([{ content: "nope", path: "../outside.ts" }]).success,
    ).toBe(false);
  });

  it("rejects out-of-app implementation files before applying an existing-app change", async () => {
    const writeTextFile = vi.fn<SandboxSession["writeTextFile"]>();
    const executor = vi.fn(async () => {
      await Promise.resolve();
      return { exitCode: 0, stderr: "", stdout: "" };
    });
    const wrapped = withImplementationFiles(executor, [
      { content: "out of scope", path: "packages/platform/src/change.ts" },
    ]);

    await expect(
      wrapped({
        appId: "inventory-queue",
        applyRoot: "/workspace/repository",
        proposal: existingAppProposal("inventory-queue"),
        // SAFETY: The rejection happens before any sandbox capability is called; writeTextFile is present if reached.
        sandbox: sandboxFixture(writeTextFile),
      }),
    ).rejects.toThrow("Existing-app implementation files must stay inside the app workspace.");
    expect(executor).not.toHaveBeenCalled();
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it("rejects an out-of-app validation repair before it can write", () => {
    const proposal = existingAppProposal("inventory-queue");
    expect(() => {
      assertExistingAppImplementationFiles(
        [{ content: "out of scope", path: "packages/platform/src/change.ts" }],
        proposal,
      );
    }).toThrow("Existing-app implementation files must stay inside the app workspace.");
    expect(() => {
      assertExistingAppImplementationFiles(
        [{ content: "in scope", path: "apps/inventory-queue/app/page.tsx" }],
        proposal,
      );
    }).not.toThrow();
  });
  it("applies explicit removal non-recursively and retries an absent file safely", async () => {
    const sandbox = {
      removePath: vi.fn<SandboxSession["removePath"]>(),
      writeTextFile: vi.fn<SandboxSession["writeTextFile"]>(),
    };
    const files = implementationFilesSchema.parse([
      { operation: "delete", path: "apps/example/server/demo.ts" },
      { content: "authenticated context", path: "apps/example/server/context.ts" },
    ]);
    await applyImplementationFiles(sandbox, "/workspace/repository", files);
    await applyImplementationFiles(sandbox, "/workspace/repository", files);
    expect(sandbox.removePath).toHaveBeenCalledWith({
      force: true,
      path: "repository/apps/example/server/demo.ts",
    });
    expect(sandbox.writeTextFile).toHaveBeenCalledWith({
      content: "authenticated context",
      path: "repository/apps/example/server/context.ts",
    });
    expect(sandbox.removePath).toHaveBeenCalledTimes(2);
  });
  it("rejects escaping removal paths and duplicate mixed operations", () => {
    for (const path of [
      "../outside",
      "/outside",
      "apps//example",
      "apps/\0example",
      "apps/example/.",
    ]) {
      expect(implementationFilesSchema.safeParse([{ operation: "delete", path }]).success).toBe(
        false,
      );
    }
    expect(
      implementationFilesSchema.safeParse([
        { operation: "delete", path: "apps/example/file.ts" },
        { content: "replacement", path: "apps/example/file.ts" },
      ]).success,
    ).toBe(false);
  });

  it("reports submission heuristics without blocking apply", () => {
    expect(
      implementationArchitectureDiagnostics(
        [
          {
            content:
              '"use client"; localStorage.setItem("draft", "value"); export default function Page() { return null; }',
            path: "app/page.tsx",
          },
        ],
        "kernel",
      ),
    ).toEqual([
      expect.stringContaining("No Server Action"),
      expect.stringContaining("browser storage"),
      expect.stringContaining("Client Component"),
    ]);
  });

  it("accepts a server route with a narrow interactive leaf for kernel data", () => {
    expect(
      implementationArchitectureDiagnostics(
        [
          {
            content:
              'import Form from "./form"; export default function Page() { return <Form />; }',
            path: "app/page.tsx",
          },
          { content: '"use server"; export async function save() {}', path: "app/actions.ts" },
          {
            content: '"use client"; export default function Form() { return <button />; }',
            path: "app/form.tsx",
          },
        ],
        "kernel",
      ),
    ).toEqual([]);
  });
});
