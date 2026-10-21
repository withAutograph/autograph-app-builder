import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { materializeFreshApplyOverlay } from "./target-apply";
import type { SandboxSession } from "eve/sandbox";

import {
  executeTargetIdentityAndPlanning,
  fixtureTargetCommandExecutor,
  materializePlanningOverlay,
  sandboxTargetCommandExecutor,
  targetIdentitySchema,
  targetExecutionBinding,
} from "./target-planning";

const appDescription = (id: string) =>
  JSON.stringify({
    app: { id, routes: [`/${id}`], workspacePath: `apps/${id}` },
    backend: {
      authorization: "declared-policy",
      kind: "generated-postgres",
      release: { artifactHash: "hash", directory: "release", id: "v1" },
      roles: ["member"],
      runtime: { databaseEnvironment: "APP_DATABASE_URL" },
      schemaReceipt: null,
    },
    validation: { browser: null, check: { task: "check" }, test: { shards: 1, task: "test" } },
    version: 1,
  });

const planningCommandOutput = (command: string, mode: string): string => {
  if (command.startsWith("stat ")) return `${mode}\n`;
  if (command.startsWith("mise run --no-deps app:describe ")) {
    return appDescription(command.split(" ").at(-1) ?? "missing-app-id");
  }
  return "";
};

describe("planning from the current checkout", () => {
  it("plans with checkout execution despite an irrelevant hosted image setting", () => {
    expect(
      targetExecutionBinding(undefined, {
        APP_BUILDER_EXECUTION_MODE: "development",
        APP_BUILDER_SANDBOX_IMAGE: "retired-local-image:latest",
        VERCEL: "1",
        VERCEL_ENV: "preview",
      }),
    ).toEqual({
      dependencyCacheDigest: "checkout",
      fixture: false,
      imageDigest: "vercel-sandbox",
    });
  });

  it("writes a large accepted AppSpec from a bounded stream without a full-content argument", async () => {
    const content = "Product outcome. ".repeat(100_000);
    const pieces = content.match(/[\s\S]{1,65536}/gu) ?? [];
    const written: string[] = [];
    const sandbox = {
      // oxlint-disable-next-line eslint/require-await -- Sandbox fixture models an asynchronous remove.
      removePath: vi.fn(async () => {}),
      // oxlint-disable-next-line eslint/require-await -- Sandbox fixture models an asynchronous copy.
      run: vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: "" })),
      async writeFile({ content: stream }: { content: ReadableStream<Uint8Array> }) {
        for await (const bytes of stream) written.push(Buffer.from(bytes).toString("utf-8"));
      },
      // oxlint-disable-next-line eslint/require-await -- Sandbox fixture models an asynchronous profile write.
      writeTextFile: vi.fn(async () => {}),
    } as unknown as SandboxSession;
    await materializePlanningOverlay({
      appId: "inventory",
      appSpecDigest: "a".repeat(64),
      appSpecStream: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const piece of pieces) controller.enqueue(Buffer.from(piece, "utf-8"));
          controller.close();
        },
      }),
      artifactRevision: "b".repeat(64),
      sandbox,
    });
    expect(written.join("")).toBe(content);
    expect(written.length).toBeGreaterThan(20);
    expect(sandbox.writeTextFile).not.toHaveBeenCalled();
  });
  it.each(["inventory-queue", "travel-approvals"])(
    "runs target identity on the live checkout with scoped setup controls for %s",
    async (appId) => {
      // oxlint-disable-next-line eslint/require-await -- model the sandbox's async command API
      const run = vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: "{}" }));
      const sandbox = { run } as unknown as SandboxSession;

      await sandboxTargetCommandExecutor(sandbox)({
        appId,
        appSpecDigest: "b".repeat(64),
        command: "identity",
        planningRoot: "/workspace/planning",
      });

      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          command: `mise run --no-deps repository:exec -- app-identity.ts --app ${appId}`,
          env: {
            MISE_EXEC_AUTO_INSTALL: "false",
            MISE_NOT_FOUND_AUTO_INSTALL: "false",
            MISE_TASK_RUN_AUTO_INSTALL: "false",
          },
          workingDirectory: "/workspace/repository",
        }),
      );
    },
  );

  it("completes identity and planning without a source inventory", async () => {
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const readTextFile = vi.fn(async ({ path }: { path: string }) => {
      if (path.includes("source-files")) {
        throw new Error("Inventory must not be required");
      }
      return null;
    });
    const executor = vi.fn(fixtureTargetCommandExecutor());
    const sandbox = {
      readTextFile,
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      removePath: vi.fn(async () => {}),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      run: vi.fn(async ({ command }: { command: string }) => ({
        exitCode: command.startsWith("test -") ? 1 : 0,
        stderr: "",
        stdout: "",
      })),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      writeTextFile: vi.fn(async () => {}),
    } as unknown as SandboxSession;
    const result = await executeTargetIdentityAndPlanning({
      appId: "stock-exceptions",
      appSpecContent: "Stock Exceptions product design",
      appSpecDigest: "b".repeat(64),
      artifactRevision: "a".repeat(64),
      executor,
      sandbox,
    });
    expect(result.proposal.contract.appId).toBe("stock-exceptions");
    expect(executor.mock.calls.map(([request]) => request.command)).toEqual(["identity"]);
  });

  it.each([
    { field: null, value: null },
    { field: "appId", value: "other" },
    { field: "workspacePath", value: "products/stock-exceptions" },
    { field: "appSpecPath", value: "products/stock-exceptions/design.md" },
    { field: "appSpecSourcePath", value: "design/stock-exceptions.md" },
    { field: "cueSourcePath", value: "schemas/stock-exceptions.cue" },
    { field: "schemaCuePath", value: "products/stock-exceptions/data/model.cue" },
    { field: "title", value: "Stock Review Desk" },
    { field: "packageName", value: "stock-review-desk" },
    { field: "packageName", value: "@company/stock-review-desk" },
    { field: "baseRoutes", value: ["/review"] },
    { field: "baseRoutes", value: ["/review", "/review/:path*", "/exceptions"] },
  ])(
    "uses repository metadata while preserving app identity ($field: $value)",
    async ({ field: changedField, value }) => {
      const fixture = fixtureTargetCommandExecutor();
      const executor = vi.fn(async (request: Parameters<typeof fixture>[0]) => {
        const result = await fixture(request);
        if (request.command !== "identity") {
          return result;
        }
        // Add producer metadata and reverse wire order to ensure only consumed
        // identity fields bind the receipt.
        const parsed = {
          ...targetIdentitySchema.parse(JSON.parse(result.stdout)),
          producerMetadata: "additional metadata",
        };
        if (changedField !== null) {
          Object.assign(parsed, {
            [changedField]: value,
          });
        }
        return {
          ...result,
          stdout: JSON.stringify(Object.fromEntries(Object.entries(parsed).toReversed())),
        };
      });
      const sandbox = {
        // oxlint-disable-next-line eslint/require-await -- framework test double
        removePath: vi.fn(async () => {}),
        // oxlint-disable-next-line eslint/require-await -- framework test double
        run: vi.fn(async ({ command }: { command: string }) => ({
          exitCode: command.startsWith("test -d") ? 1 : 0,
          stderr: "",
          stdout: "",
        })),
        // oxlint-disable-next-line eslint/require-await -- framework test double
        writeTextFile: vi.fn(async () => {}),
      } as unknown as SandboxSession;
      const planning = executeTargetIdentityAndPlanning({
        appId: "stock-exceptions",
        appSpecContent: "Stock Exceptions product design",
        appSpecDigest: "b".repeat(64),
        artifactRevision: "a".repeat(64),
        executor,
        sandbox,
      });
      if (changedField === "appId") {
        await expect(planning).rejects.toThrow(
          "Target identity did not match the accepted app id.",
        );
        expect(executor.mock.calls.map(([request]) => request.command)).toEqual(["identity"]);
      } else {
        const result = await planning;
        expect(result.identity).not.toHaveProperty("producerMetadata");
        expect(result.proposal.contract.appId).toBe("stock-exceptions");
        if (changedField !== null) {
          expect(result.identity).toHaveProperty(changedField, value);
        }
        if (changedField === "workspacePath" || changedField === "packageName") {
          expect(result.proposal.plan.source).toHaveProperty(changedField, value);
        }
        if (changedField === "baseRoutes") {
          expect(result.proposal.plan.topology.routes).toEqual(value);
        }
      }
    },
  );

  it("runs creation planning when new-app drafts are supplied", async () => {
    const executor = vi.fn(fixtureTargetCommandExecutor());
    const sandbox = {
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      removePath: vi.fn(async () => {}),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      run: vi.fn(async ({ command }: { command: string }) => ({
        exitCode: command.startsWith("test -") ? 1 : 0,
        stderr: "",
        stdout: "",
      })),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      writeTextFile: vi.fn(async () => {}),
    } as unknown as SandboxSession;

    const result = await executeTargetIdentityAndPlanning({
      appId: "stock-exceptions",
      appSpecContent: "Stock Exceptions product design",
      appSpecDigest: "b".repeat(64),
      artifactRevision: "a".repeat(64),
      executor,
      existingAppChanges: [
        {
          content: "new component",
          path: "apps/stock-exceptions/app/page.tsx",
        },
      ],
      sandbox,
    });

    expect(result.proposal).not.toHaveProperty("operation");
    expect(executor.mock.calls.map(([request]) => request.command)).toEqual(["identity"]);
  });

  it("plans existing-app edits with the repository's project name", async () => {
    const before = Buffer.from("old component");
    const fixture = fixtureTargetCommandExecutor();
    const executor = async (request: Parameters<typeof fixture>[0]) => {
      const result = await fixture(request);
      return {
        ...result,
        stdout: JSON.stringify({
          ...targetIdentitySchema.parse(JSON.parse(result.stdout)),
          projectName: "inventory-queue",
        }),
      };
    };
    const sandbox = {
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      readBinaryFile: vi.fn(async () => before),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      readTextFile: vi.fn(async () => null),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      removePath: vi.fn(async () => {}),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      run: vi.fn(async ({ command }: { command: string }) => ({
        exitCode: 0,
        stderr: "",
        stdout: planningCommandOutput(command, "755"),
      })),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      writeTextFile: vi.fn(async () => {}),
    } as unknown as SandboxSession;
    const result = await executeTargetIdentityAndPlanning({
      appId: "inventory-queue",
      appSpecContent: "Improve Inventory Queue",
      appSpecDigest: "b".repeat(64),
      artifactRevision: "a".repeat(64),
      executor,
      existingAppChanges: [{ content: "new component", path: "apps/inventory-queue/app/page.tsx" }],
      sandbox,
    });
    expect(result.proposal).toMatchObject({
      iteration: {
        changes: [
          {
            after: { content: "new component", mode: "755" },
            before: { mode: "755" },
          },
        ],
      },
      operation: "iterate-existing-app",
      plan: { topology: { projectName: "inventory-queue" } },
    });
    expect(sandbox.readBinaryFile).toHaveBeenCalledWith({
      path: "repository/apps/inventory-queue/app/page.tsx",
    });
    expect(sandbox.readBinaryFile).not.toHaveBeenCalledWith({
      path: "repository/microfrontends.json",
    });
  });
  it("discovers an existing backend and plans removal plus replacement with original preimages", async () => {
    const sandbox = {
      // oxlint-disable-next-line eslint/require-await -- Sandbox fixture preserves its asynchronous file API.
      readBinaryFile: vi.fn(async ({ path }: { path: string }) =>
        path.endsWith("demo.ts") ? Buffer.from("demo") : null,
      ),
      removePath: vi.fn(async () => {}),
      // oxlint-disable-next-line eslint/require-await -- Sandbox fixture preserves its asynchronous command API.
      run: vi.fn(async ({ command }: { command: string }) => ({
        exitCode: 0,
        stderr: "",
        stdout: planningCommandOutput(command, "644"),
      })),
      writeTextFile: vi.fn(async () => {}),
    } as unknown as SandboxSession;
    const result = await executeTargetIdentityAndPlanning({
      appId: "example",
      appSpecContent: "Authenticated Example",
      appSpecDigest: "b".repeat(64),
      artifactRevision: "a".repeat(64),
      executor: fixtureTargetCommandExecutor(),
      existingAppChanges: [
        { operation: "delete", path: "apps/example/server/demo.ts" },
        { content: "authenticated", path: "apps/example/server/context.ts" },
      ],
      sandbox,
    });
    expect(result.proposal).toMatchObject({
      iteration: {
        changes: [
          { before: { mode: "644" }, path: "apps/example/server/demo.ts" },
          { after: { content: "authenticated" }, path: "apps/example/server/context.ts" },
        ],
      },
      operation: "iterate-existing-app",
      plan: { source: { schema: { kind: "kernel", path: "apps/example/schema/example.cue" } } },
    });
    if (!("operation" in result.proposal)) throw new Error("Expected revision");
    expect(result.proposal.iteration.changes[0]).not.toHaveProperty("after");
    expect(sandbox.run).toHaveBeenCalledWith({
      command: "mise run --no-deps app:describe example",
      workingDirectory: "/workspace/repository",
    });
  });
  it.each([null, "invalid old inventory"])(
    "retains only accepted scratch input without requiring a source inventory (%s)",
    async (manifest) => {
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      const run = vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: "" }));
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      const readTextFile = vi.fn(async () => manifest);
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      const writeTextFile = vi.fn(async () => {});
      const sandbox = {
        readTextFile,
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        removePath: vi.fn(async () => {}),
        run,
        writeTextFile,
      } as unknown as SandboxSession;

      const result = await materializePlanningOverlay({
        appId: "stock-exceptions",
        appSpecContent: "Stock Exceptions product design",
        appSpecDigest: "b".repeat(64),
        artifactRevision: "a".repeat(64),
        sandbox,
      });

      expect(readTextFile).not.toHaveBeenCalled();
      expect(result.planningRoot).toBe(
        `/workspace/.app-builder/target-inputs/${"a".repeat(64)}/repository`,
      );
      expect(writeTextFile).toHaveBeenCalledWith({
        content: "Stock Exceptions product design",
        path: `.app-builder/target-inputs/${"a".repeat(64)}/repository/prototype/stock-exceptions/app-spec.md`,
      });
    },
  );

  it("observes ordinary source edits and new files while retaining accepted input outside source", async () => {
    const revision = "a".repeat(64);
    const scratchRoot = `/workspace/.app-builder/target-inputs/${revision}/repository`;
    const sourceRoot = "/workspace/repository";
    const identityFile = `${sourceRoot}/repository-identity.txt`;
    const spec = "Accepted product requirements";
    const specDigest = createHash("sha256").update(spec).digest("hex");
    const files = new Map([[identityFile, "Initial title"]]);
    const identityResult = await fixtureTargetCommandExecutor()({
      appId: "example",
      appSpecDigest: specDigest,
      command: "identity",
      planningRoot: scratchRoot,
    });
    const identity = targetIdentitySchema.parse(JSON.parse(identityResult.stdout));
    const run = vi.fn<SandboxSession["run"]>((input) => {
      const result = { exitCode: 0, stderr: "", stdout: "" };
      if (input.command.startsWith("mkdir ")) {
        return Promise.resolve(result);
      }
      if (input.command.includes("app-identity.ts")) {
        const title = files.get(`${input.workingDirectory}/repository-identity.txt`);
        if (title === undefined) {
          throw new Error("Identity did not read the live source");
        }
        return Promise.resolve({ ...result, stdout: JSON.stringify({ ...identity, title }) });
      }
      if (input.command.startsWith("test -d ")) {
        return Promise.resolve({ ...result, exitCode: 1 });
      }
      if (input.command.startsWith("test -f ")) {
        const path = `${input.workingDirectory}/${input.command.slice("test -f ".length)}`;
        return Promise.resolve({ ...result, exitCode: files.has(path) ? 0 : 1 });
      }
      throw new Error("Unexpected planning filesystem mutation or command");
    });
    const sandbox = {
      run,
      removePath: ({ path }: { path: string }) => {
        for (const file of files.keys()) {
          if (file.startsWith(`/workspace/${path}/`)) {
            files.delete(file);
          }
        }
        return Promise.resolve();
      },
      writeTextFile: ({ path, content }: { path: string; content: string }) => {
        files.set(`/workspace/${path}`, content);
        return Promise.resolve();
      },
      readBinaryFile: ({ path }: { path: string }) => {
        const content = files.get(`/workspace/${path}`);
        return Promise.resolve(content === undefined ? null : Buffer.from(content));
      },
    } as unknown as SandboxSession;
    const plan = () =>
      executeTargetIdentityAndPlanning({
        appId: "example",
        appSpecContent: spec,
        appSpecDigest: specDigest,
        artifactRevision: revision,
        executor: sandboxTargetCommandExecutor(sandbox),
        sandbox,
      });
    const first = await plan();
    expect(first.identity.title).toBe("Initial title");
    expect(first.proposal).toMatchObject({ plan: { source: { schema: { kind: "none" } } } });
    files.set(identityFile, "Updated title");
    files.set(`${sourceRoot}/${identity.cueSourcePath}`, "new schema input");
    const updated = await plan();
    expect(updated.identity.title).toBe("Updated title");
    expect(updated.proposal).toMatchObject({ plan: { source: { schema: { kind: "kernel" } } } });
    expect(updated.planningRoot).toBe(scratchRoot);
    expect(files.get(`${scratchRoot}/${updated.proposal.contract.appSpec.path}`)).toBe(
      "Accepted product requirements",
    );
    expect(files.has(`${sourceRoot}/${updated.proposal.contract.appSpec.path}`)).toBe(false);
    expect(files.get(identityFile)).toBe("Updated title");
    const apply = await materializeFreshApplyOverlay({
      sandbox,
      artifactRevision: revision,
      proposalDigest: "c".repeat(64),
      proposal: updated.proposal,
    });
    expect(Buffer.from(apply.acceptedAppSpec).toString("utf-8")).toBe(spec);
    expect(apply.applyRoot).toBe(sourceRoot);
  });

  it("preserves an actual repository identity failure", async () => {
    const failure = { exitCode: 128, stderr: "Git could not read this checkout", stdout: "" };
    const run = vi.fn<SandboxSession["run"]>().mockResolvedValue(failure);
    const sandbox = { run } as unknown as SandboxSession;
    await expect(
      sandboxTargetCommandExecutor(sandbox)({
        appId: "stock-exceptions",
        appSpecDigest: "b".repeat(64),
        command: "identity",
        planningRoot: "/workspace/private-planning-input",
      }),
    ).resolves.toBe(failure);
  });

  it("preserves an actual sandbox rejection while inspecting identity", async () => {
    const failure = new Error("sandbox command timed out");
    const run = vi.fn<SandboxSession["run"]>().mockRejectedValue(failure);
    const sandbox = { run } as unknown as SandboxSession;
    await expect(
      sandboxTargetCommandExecutor(sandbox)({
        appId: "stock-exceptions",
        appSpecDigest: "b".repeat(64),
        command: "identity",
        planningRoot: "/workspace/private-planning-input",
      }),
    ).rejects.toBe(failure);
  });

  it("repairs missing identity dependencies in the live checkout and retries the command", async () => {
    const run = vi
      .fn<SandboxSession["run"]>()
      .mockResolvedValueOnce({ exitCode: 1, stderr: "Cannot find module dependency", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "installed" })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "identity" });
    const setNetworkPolicy = vi.fn(() => Promise.resolve());
    const sandbox = { run, setNetworkPolicy } as unknown as SandboxSession;
    const result = await sandboxTargetCommandExecutor(sandbox)({
      appId: "stock-exceptions",
      appSpecDigest: "b".repeat(64),
      command: "identity",
      planningRoot: "/workspace/private-planning-input",
    });
    expect(result.stdout).toBe("identity");
    expect(setNetworkPolicy).toHaveBeenCalledWith("allow-all");
    expect(run).toHaveBeenCalledWith({
      command: "bun install --ignore-scripts --filter @autograph/platform-microfrontends",
      workingDirectory: "/workspace/repository",
    });
  });

  it("includes mkdir stderr when preparing the planning workspace fails", async () => {
    const sandbox = {
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      removePath: vi.fn(async () => {}),
      run: vi.fn().mockResolvedValue({
        exitCode: 1,
        stderr: "mkdir: no space left on device",
        stdout: "",
      }),
    } as unknown as SandboxSession;
    await expect(
      materializePlanningOverlay({
        appId: "stock-exceptions",
        appSpecContent: "Stock Exceptions product design",
        appSpecDigest: "b".repeat(64),
        artifactRevision: "a".repeat(64),
        sandbox,
      }),
    ).rejects.toThrow(
      /create .*workspace directory paths \(exit 1\).*Check write permissions.*no space left on device/u,
    );
  });
});
