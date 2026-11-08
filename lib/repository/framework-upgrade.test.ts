import { workspaceBinInstallCommand } from "./workspace-bin-install";
import { developmentExecutionEnvironment } from "../development/execution-environment.mjs";
/* oxlint-disable eslint/require-await -- Async sandbox and registry fixtures implement Promise-returning I/O ports without real network/process work. */
import {
  reviewableChanges,
  baselineReviewableChanges,
  changedAppTextPaths,
} from "../../agent/tools/change_set_status";
import { describe, expect, it, vi } from "vitest";
import type { FrameworkRegistryFetch } from "./framework-upgrade";
import type { SandboxSession } from "eve/sandbox";
import {
  frameworkUpgradeCommand,
  planFrameworkUpgrade,
  resolveLatestFrameworkVersions,
} from "./framework-upgrade";
import {
  iterationBaselineSnapshot,
  overlayChanges,
  reviewedOverlayTreeDigest,
  sandboxApplyCommandExecutor,
} from "./target-apply";
import { assertExistingAppReviewScope } from "./reviewed-change-set";
import {
  executeTargetIdentityAndPlanning,
  fixtureTargetCommandExecutor,
  targetIterationProposalSchema,
} from "./target-planning";

const versions = {
  next: "16.4.3",
  react: "19.3.1",
  reactDom: "19.3.1",
  typesReact: "19.3.0",
  typesReactDom: "19.3.0",
};
const upgrade = { baseline: [], scope: "workspace" as const, versions };
const proposal = () =>
  targetIterationProposalSchema.parse({
    blockers: [],
    contract: {
      appId: "example",
      appSpec: { path: "prototype/example/app-spec.md", sha256: "a".repeat(64) },
      version: 1,
    },
    frameworkUpgrade: upgrade,
    iteration: {
      changes: [],
      digest: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    },
    mutations: [],
    operation: "iterate-existing-app",
    plan: {
      product: { appSpec: { path: "prototype/example/app-spec.md", sha256: "a".repeat(64) } },
      source: {
        packageName: "@autograph/example",
        runtime: "nextjs",
        schema: { kind: "none" },
        workspacePath: "apps/example",
      },
      topology: {
        configPath: "microfrontends.json",
        packageName: "@autograph/example",
        projectName: "apps-example",
        routes: ["/example"],
      },
    },
  });
interface RegistryMetadata {
  version: string;
  peerDependencies?: Record<string, string>;
}
const registry = (overrides: Record<string, RegistryMetadata> = {}) => {
  const read: FrameworkRegistryFetch = async (url) => {
    const resource = url.slice("https://registry.npmjs.org/".length);
    const metadataRequest = !resource.includes("/");
    const name = decodeURIComponent(
      metadataRequest ? resource : resource.slice(0, resource.lastIndexOf("/")),
    );
    const packages = new Map<string, RegistryMetadata>([
      [
        "next",
        {
          version: "16.4.3",
          peerDependencies: { react: "^18.2.0 || ^19.0.0", "react-dom": "^18.2.0 || ^19.0.0" },
        },
      ],
      ["react", { version: "19.3.1" }],
      ["react-dom", { version: "19.3.1", peerDependencies: { react: "^19.3.1" } }],
      ["@types/react", { version: "19.3.0" }],
      ["@types/react-dom", { version: "19.3.0", peerDependencies: { "@types/react": "^19.0.0" } }],
      ...Object.entries(overrides),
    ]);
    const current = packages.get(name);
    if (current === undefined) {
      return new Response("missing", { status: 404 });
    }
    let legacy: RegistryMetadata = { version: "18.3.1" };
    if (name === "react-dom") {
      legacy = { version: "18.3.1", peerDependencies: { react: "^18.3.1" } };
    }
    if (name === "@types/react-dom") {
      legacy = { version: "18.3.1", peerDependencies: { "@types/react": "^18.0.0" } };
    }
    return Response.json(
      metadataRequest
        ? { versions: { [current.version]: current, [legacy.version]: legacy } }
        : current,
    );
  };
  return vi.fn(read);
};

interface FixtureSandboxPorts extends Partial<SandboxSession> {
  setNetworkPolicy?: () => Promise<void>;
}
const fixtureCommandExit = (command: string, existing: boolean) => {
  if (command.startsWith("test -d")) {
    return existing ? 0 : 1;
  }
  return command.startsWith("test -f") ? 1 : 0;
};
const unexpectedSandboxOperation = () =>
  Promise.reject(new Error("Unexpected sandbox operation in framework upgrade fixture"));
const sandboxFixture = (ports: FixtureSandboxPorts): SandboxSession => ({
  readBinaryFile: unexpectedSandboxOperation,
  readFile: unexpectedSandboxOperation,
  readTextFile: unexpectedSandboxOperation,
  removePath: unexpectedSandboxOperation,
  resolvePath: () => {
    throw new Error("Unexpected sandbox operation in framework upgrade fixture");
  },
  run: unexpectedSandboxOperation,
  spawn: unexpectedSandboxOperation,
  writeBinaryFile: unexpectedSandboxOperation,
  writeFile: unexpectedSandboxOperation,
  writeTextFile: unexpectedSandboxOperation,
  ...ports,
});

describe("framework upgrade planning and apply", () => {
  it("resolves stable peer-compatible releases and matches React DOM to React", async () => {
    const fetcher = registry();
    await expect(resolveLatestFrameworkVersions(fetcher)).resolves.toEqual(versions);
    expect(vi.mocked(fetcher).mock.calls.some(([url]) => url.endsWith("react-dom/19.3.1"))).toBe(
      true,
    );
  });
  it("reports registry failure rather than silently selecting remembered versions", async () => {
    await expect(
      resolveLatestFrameworkVersions(async () => new Response("unavailable", { status: 503 })),
    ).rejects.toThrow("npm returned 503");
  });
  it("selects the latest stable compatible pair when npm latest has incompatible peers", async () => {
    await expect(
      resolveLatestFrameworkVersions(
        registry({ next: { version: "16.4.3", peerDependencies: { react: "^18.0.0" } } }),
      ),
    ).resolves.toMatchObject({
      react: "18.3.1",
      reactDom: "18.3.1",
      typesReact: "18.3.1",
      typesReactDom: "18.3.1",
    });
  });
  it("falls back to a published compatible pair when React DOM has not published React latest yet", async () => {
    const fallback = registry();
    const fetcher: FrameworkRegistryFetch = async (url, init) => {
      if (url.endsWith("react-dom/19.3.1")) {
        return new Response("missing", { status: 404 });
      }
      if (url.endsWith("/react-dom")) {
        return Response.json({
          versions: { "18.3.1": { version: "18.3.1", peerDependencies: { react: "^18.3.1" } } },
        });
      }
      return await fallback(url, init);
    };
    await expect(resolveLatestFrameworkVersions(fetcher)).resolves.toMatchObject({
      react: "18.3.1",
      reactDom: "18.3.1",
    });
  });
  it("does not adopt prereleases", async () => {
    await expect(
      resolveLatestFrameworkVersions(registry({ next: { version: "17.0.0-canary.1" } })),
    ).rejects.toThrow();
  });
  it("auto-plans concrete versions for new apps and supports version-only existing app plans", async () => {
    const resolver = vi.fn(async () => versions);
    let existing = false;
    const sandbox = sandboxFixture({
      readBinaryFile: async () => null,
      readTextFile: async () => null,
      writeTextFile: async () => {},
      removePath: async () => {},
      run: async ({ command }: { command: string }) => ({
        exitCode: fixtureCommandExit(command, existing),
        stdout: command.startsWith("mise run --no-deps app:describe")
          ? JSON.stringify({
              version: 1,
              app: { id: "example", routes: ["/example"], workspacePath: "apps/example" },
              backend: { kind: "static" },
              validation: {
                check: { task: "check" },
                test: { task: "test", shards: 1 },
                browser: null,
              },
            })
          : "",
        stderr: "",
      }),
    });
    const input = {
      sandbox,
      appId: "example",
      appSpecContent: "Example",
      appSpecDigest: "a".repeat(64),
      artifactRevision: "b".repeat(64),
      executor: fixtureTargetCommandExecutor(),
      resolveFrameworkVersions: resolver,
    };
    const created = await executeTargetIdentityAndPlanning(input);
    expect(created.proposal.frameworkUpgrade?.versions).toEqual(versions);
    existing = true;
    const iteration = await executeTargetIdentityAndPlanning({
      ...input,
      frameworkUpgradeRequested: true,
    });
    expect(iteration.proposal).toMatchObject({
      frameworkUpgrade: { versions },
      iteration: { changes: [] },
      operation: "iterate-existing-app",
    });
    expect(resolver).toHaveBeenCalledTimes(2);
    const ordinary = await executeTargetIdentityAndPlanning({
      ...input,
      existingAppChanges: [
        { path: "apps/example/app/page.tsx", content: "Existing product feature edit" },
      ],
    });
    expect(ordinary.proposal.frameworkUpgrade).toBeUndefined();
    expect(resolver).toHaveBeenCalledTimes(2);
  });
  it("plans a fresh local base-only iteration without inventing app edits or framework upgrades", async () => {
    const sandbox = sandboxFixture({
      readBinaryFile: async () => null,
      readTextFile: async () => null,
      writeTextFile: async () => {},
      removePath: async () => {},
      run: async ({ command }: { command: string }) => ({
        exitCode: fixtureCommandExit(command, true),
        stderr: "",
        stdout: command.startsWith("mise run --no-deps app:describe")
          ? JSON.stringify({
              version: 1,
              app: { id: "example", routes: ["/example"], workspacePath: "apps/example" },
              backend: { kind: "static" },
              validation: {
                check: { task: "check" },
                test: { task: "test", shards: 1 },
                browser: null,
              },
            })
          : "",
      }),
    });
    const sourceReceipt = {
      adapter: "arrusted-development-v0" as const,
      contractDigest: "e".repeat(64),
      digest: "f".repeat(64),
      eligibilityDigest: "d".repeat(64),
      releaseEnabled: false as const,
      sourceKind: "fresh-template" as const,
      sourcePath: "/fixture/source",
      sourceSha: "a".repeat(40),
      sourceTree: "b".repeat(40),
      version: 3 as const,
    };
    const localSourceReconciliation = {
      kind: "local-source-reconciliation-v1" as const,
      appId: "example",
      appSpecDigest: "a".repeat(64),
      workspaceId: "saved-workspace",
      previousApplyDigest: "b".repeat(64),
      previousProposalDigest: "c".repeat(64),
      previousSourceReceiptDigest: "d".repeat(64),
      sourceReceiptDigest: sourceReceipt.digest,
      previousWorkspaceDigest: "1".repeat(64),
      workspaceDigest: "2".repeat(64),
      sourceSnapshotTree: "3".repeat(40),
      checkpointRef: `refs/app-builder/local-source-checkpoints/${"4".repeat(64)}/${"5".repeat(40)}/${"6".repeat(40)}`,
      reconciledByCallId: "prepare-new-base",
    };
    const input = {
      sandbox,
      appId: "example",
      appSpecContent: "Accepted unchanged product",
      appSpecDigest: "a".repeat(64),
      artifactRevision: "b".repeat(64),
      executor: fixtureTargetCommandExecutor(),
      environment: developmentExecutionEnvironment,
      sourceReceipt,
      localSourceReconciliation,
    };
    const result = await executeTargetIdentityAndPlanning(input);
    expect(result.proposal).toMatchObject({
      iteration: { changes: [] },
      operation: "iterate-existing-app",
      sourceReconciliation: localSourceReconciliation,
    });
    expect(result.proposal.frameworkUpgrade).toBeUndefined();
    await expect(executeTargetIdentityAndPlanning({ ...input, environment: {} })).rejects.toThrow(
      "does not belong",
    );
    await expect(
      executeTargetIdentityAndPlanning({
        ...input,
        localSourceReconciliation: {
          ...localSourceReconciliation,
          sourceReceiptDigest: "0".repeat(64),
        },
      }),
    ).rejects.toThrow("does not belong");
    await expect(
      executeTargetIdentityAndPlanning({ ...input, localSourceReconciliation: undefined }),
    ).rejects.toThrow();
    expect(
      targetIterationProposalSchema.safeParse({
        ...result.proposal,
        sourceReconciliation: { ...localSourceReconciliation, appId: "other" },
      }).success,
    ).toBe(false);
  });
  it("captures original shared file preimages so a retry still reviews their edits", async () => {
    const sandbox = sandboxFixture({
      readBinaryFile: async ({ path }: { path: string }) =>
        path.endsWith("package.json") ? Buffer.from("old package") : null,
      run: async () => ({ exitCode: 0, stdout: "644", stderr: "" }),
    });
    const planned = await planFrameworkUpgrade(sandbox, versions);
    const changed = {
      files: [
        { path: "package.json", mode: "644", digest: "f".repeat(64) },
        { path: "bun.lock", mode: "644", digest: "e".repeat(64) },
      ],
      treeDigest: "changed",
    };
    expect(
      overlayChanges(iterationBaselineSnapshot(changed, planned.baseline), changed).map(
        ({ path, kind }) => ({ path, kind }),
      ),
    ).toEqual([
      { kind: "added", path: "bun.lock" },
      { kind: "modified", path: "package.json" },
    ]);
  });
  it("upgrades an existing app without regenerating or overwriting app source", async () => {
    const calls: string[] = [];
    const sandbox = sandboxFixture({
      setNetworkPolicy: async () => {},
      run: async ({ command }: { command: string }) => {
        calls.push(command);
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
      writeTextFile: vi.fn<SandboxSession["writeTextFile"]>(),
      readBinaryFile: vi.fn<SandboxSession["readBinaryFile"]>(),
    });
    const result = await sandboxApplyCommandExecutor()({
      sandbox,
      appId: "example",
      applyRoot: "/workspace/repository",
      proposal: proposal(),
    });
    expect(result.exitCode).toBe(0);
    expect(calls).toContain(frameworkUpgradeCommand(upgrade, "example"));
    expect(calls).toContain(workspaceBinInstallCommand("/workspace/repository", true));
    expect(calls.some((c) => c.includes("create:app"))).toBe(false);
    expect(sandbox.writeTextFile).not.toHaveBeenCalled();
  });
  it("retains the planned versions when installation fails and is retried", async () => {
    const calls: string[] = [];
    let fail = true;
    const sandbox = sandboxFixture({
      setNetworkPolicy: async () => {},
      run: async ({ command }: { command: string }) => {
        calls.push(command);
        if (command.includes("repository:upgrade-framework") && fail) {
          return { exitCode: 1, stdout: "", stderr: "network timeout" };
        }
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    });
    const apply = () =>
      sandboxApplyCommandExecutor()({
        sandbox,
        appId: "example",
        applyRoot: "/workspace/repository",
        proposal: proposal(),
      });
    const failed = await apply();
    expect(failed.exitCode).toBe(1);
    fail = false;
    const retried = await apply();
    expect(retried.exitCode).toBe(0);
    expect(calls.filter((c) => c.includes("repository:upgrade-framework"))).toEqual([
      frameworkUpgradeCommand(upgrade, "example"),
      frameworkUpgradeCommand(upgrade, "example"),
    ]);
  });
  it("normal iterations still install existing dependencies without upgrading", async () => {
    const p = proposal();
    delete p.frameworkUpgrade;
    p.iteration.changes = [];
    const calls: string[] = [];
    const sandbox = sandboxFixture({
      setNetworkPolicy: async () => {},
      run: async ({ command }: { command: string }) => {
        calls.push(command);
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    });
    await sandboxApplyCommandExecutor()({
      sandbox,
      appId: "example",
      applyRoot: "/workspace/repository",
      proposal: p,
    });
    expect(calls).toContain(workspaceBinInstallCommand("/workspace/repository", false));
    expect(calls.some((c) => c.includes("upgrade-framework"))).toBe(false);
  });
  it("exports approved shared framework files for both ordinary and baseline app review", () => {
    const changes = [
      { path: "apps/example/app/page.tsx", kind: "modified" as const },
      { path: "package.json", kind: "modified" as const },
      { path: "bun.lock", kind: "modified" as const },
      { path: "apps/other/app/page.tsx", kind: "modified" as const },
    ];
    const reviewed = reviewableChanges(changes, "example", true, true);
    expect(reviewed.map(({ path }) => path)).toEqual([
      "apps/example/app/page.tsx",
      "package.json",
      "bun.lock",
    ]);
    expect(baselineReviewableChanges(changes, "example", false, true)).toEqual(reviewed);
    expect(changedAppTextPaths(reviewed, "example", ["package.json", "bun.lock"])).toEqual([
      "apps/example/app/page.tsx",
      "package.json",
      "bun.lock",
    ]);
    expect(reviewableChanges(changes, "example", true).map(({ path }) => path)).toEqual([
      "apps/example/app/page.tsx",
    ]);
  });
  it("binds shared dependency edits to upgrade review while ordinary edits stay app-scoped", () => {
    const before = {
      files: [
        { path: "apps/example/app/page.tsx", mode: "644", digest: "a".repeat(64) },
        { path: "package.json", mode: "644", digest: "b".repeat(64) },
      ],
      treeDigest: "before",
    };
    const after = {
      files: [before.files[0], { path: "package.json", mode: "644", digest: "c".repeat(64) }],
      treeDigest: "after",
    };
    expect(reviewedOverlayTreeDigest(before, "example", true)).toBe(
      reviewedOverlayTreeDigest(after, "example", true),
    );
    expect(reviewedOverlayTreeDigest(before, "example", true, true)).not.toBe(
      reviewedOverlayTreeDigest(after, "example", true, true),
    );
    expect(() => {
      assertExistingAppReviewScope(
        { approvedPaths: ["package.json", "bun.lock"], frameworkUpgrade: versions },
        "example",
        "existing-repository",
      );
    }).not.toThrow();
    expect(() => {
      assertExistingAppReviewScope(
        { approvedPaths: ["package.json"] },
        "example",
        "existing-repository",
      );
    }).toThrow("outside");
    expect(() => {
      assertExistingAppReviewScope(
        { approvedPaths: ["apps/other/app/page.tsx"], frameworkUpgrade: versions },
        "example",
        "existing-repository",
      );
    }).toThrow("outside");
  });
});

it("plans an unchanged imported application under its own fresh Build proposal", () => {
  const { frameworkUpgrade: priorUpgrade, ...base } = proposal();
  void priorUpgrade;
  expect(() => targetIterationProposalSchema.parse(base)).toThrow();
  const imported = targetIterationProposalSchema.parse({
    ...base,
    applicationSourceImport: {
      appId: "example",
      importedSessionId: "new-authenticated-session",
      manifestDigest: "c".repeat(64),
      registration: {
        oldDigest: "d".repeat(64),
        newDigest: "e".repeat(64),
        proposedBytes: "{}",
        projectName: "example",
        assetRoute: "/example/:path*",
      },
    },
  });
  expect(imported.operation).toBe("iterate-existing-app");
  expect(imported.iteration.changes).toEqual([]);
  expect(() =>
    targetIterationProposalSchema.parse({
      ...base,
      applicationSourceImport: { ...imported.applicationSourceImport, appId: "different-app" },
    }),
  ).toThrow();
});
