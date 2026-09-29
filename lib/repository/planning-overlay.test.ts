import { describe, expect, it, vi } from "vitest";
import type { SandboxSession } from "eve/sandbox";

import {
  executeTargetIdentityAndPlanning,
  fixtureTargetCommandExecutor,
  materializePlanningOverlay,
  sandboxTargetCommandExecutor,
  targetIdentitySchema,
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
  if (command.startsWith("mise run app:describe ")) {
    return appDescription(command.split(" ").at(-1) ?? "missing-app-id");
  }
  return "";
};

describe("planning from the current checkout", () => {
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
    expect(sandbox.writeTextFile).toHaveBeenCalledTimes(1);
  });
  it.each(["inventory-queue", "travel-approvals"])(
    "uses the planning mise profile for target identity commands for %s",
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
          command: `mise run repository:exec -- app-identity.ts --app ${appId}`,
          env: { MISE_ENV: "app-builder" },
          workingDirectory: "/workspace/planning",
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

  it.each([undefined, "appId", "workspacePath", "appSpecPath"])(
    "projects current producer metadata while preserving identity binding (%s)",
    async (changedField) => {
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
        if (changedField !== undefined) {
          Object.assign(parsed, {
            [changedField]: changedField === "appId" ? "other" : "apps/other",
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
      if (changedField === undefined) {
        const result = await planning;
        expect(result.identity).not.toHaveProperty("producerMetadata");
        expect(result.proposal.contract.appId).toBe("stock-exceptions");
      } else {
        await expect(planning).rejects.toThrow(
          "Target identity did not match the accepted app id.",
        );
        expect(executor.mock.calls.map(([request]) => request.command)).toEqual(["identity"]);
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
      command: "mise run app:describe example",
      workingDirectory: "/workspace/repository",
    });
  });
  it.each([null, "invalid old inventory"])(
    "copies current files without requiring an inspection manifest (%s)",
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
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          command: expect.stringContaining("cp -R /workspace/repository/."),
        }),
      );
      expect(result.planningRoot).toContain("/workspace/");
      expect(writeTextFile).toHaveBeenCalledWith(
        expect.objectContaining({ content: "Stock Exceptions product design" }),
      );
    },
  );

  it("reports an actual checkout copy failure", async () => {
    const sandbox = {
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      removePath: vi.fn(async () => {}),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      run: vi.fn(async ({ command }: { command: string }) => ({
        exitCode: command.startsWith("cp ") ? 1 : 0,
        stderr: command.startsWith("cp ") ? "cp: cannot stat /workspace/repository" : "",
        stdout: "",
      })),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      writeTextFile: vi.fn(async () => {}),
    } as unknown as SandboxSession;

    await expect(
      materializePlanningOverlay({
        appId: "stock-exceptions",
        appSpecContent: "Stock Exceptions product design",
        appSpecDigest: "b".repeat(64),
        artifactRevision: "a".repeat(64),
        sandbox,
      }),
    ).rejects.toThrow(/source copy.*exit 1.*Check that.*cannot stat/u);
  });

  it("names a sandbox rejection while copying the current checkout", async () => {
    const sandbox = {
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      removePath: vi.fn(async () => {}),
      run: vi
        .fn()
        .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "" })
        .mockRejectedValueOnce(new Error("sandbox command timed out")),
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
      /source copy into the planning overlay could not run.*sandbox command timed out/u,
    );
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
