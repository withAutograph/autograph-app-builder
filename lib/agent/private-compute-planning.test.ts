import type { SandboxSession } from "eve/sandbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// oxlint-disable-next-line sonarjs/no-internal-api-use -- Use the installed Eve state container to check the real workflow state.
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import {
  PRIVATE_COMPUTE_CHECK_TASK,
  PRIVATE_COMPUTE_PROFILE_ID,
  privateComputeProfileSchema,
  readPrivateComputeLimits,
} from "../sandbox/private-compute-profile";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Observe the provider lookup without replacing the rest of the planning module.
import * as previewProvider from "../sandbox/vercel-preview-provider";
import {
  preparePrivateComputePlanning,
  samePrivateComputeIntent,
} from "./private-compute-planning";
import { APP_BUILDER_WORKFLOW_VERSION, appBuilderWorkflowState } from "./workflow-state";
import type { AppBuilderWorkflowState } from "./workflow-state";

const profile = () =>
  privateComputeProfileSchema.parse({
    version: 1,
    id: "private-checks-16gib-v1",
    vcpus: 8,
    memoryMiB: 16_384,
    lintWorkers: 1,
    target: { sandboxId: "same", workspaceDrive: "same-drive" },
    checkPolicy: {
      path: "apps/example/.config/mise/tasks/check",
      beforeSha256: "a".repeat(64),
      afterSha256: "b".repeat(64),
    },
    limits: {
      limited: false,
      maxVcpus: 8,
      observedAt: "2026-11-03T12:00:00.000Z",
      plan: "pro",
      projectId: "prj_owned",
      teamId: "team_owned",
      version: 1,
    },
  });
describe("private compute planning identity", () => {
  it("requires new planning for a first selection or changed physical target", () => {
    const next = profile();
    expect(samePrivateComputeIntent(undefined, next)).toBe(false);
    expect(
      samePrivateComputeIntent(next, { ...next, target: { ...next.target, sandboxId: "other" } }),
    ).toBe(false);
    expect(
      samePrivateComputeIntent(next, {
        ...next,
        target: { ...next.target, workspaceDrive: "other" },
      }),
    ).toBe(false);
    expect(
      samePrivateComputeIntent(next, {
        ...next,
        limits: { ...next.limits, projectId: "prj_other" },
      }),
    ).toBe(false);
    expect(
      samePrivateComputeIntent(next, {
        ...next,
        checkPolicy: { ...next.checkPolicy, afterSha256: "c".repeat(64) },
      }),
    ).toBe(false);
  });
  it("retains a completed intent across timestamp refresh and installed preimage", () => {
    const next = profile();
    expect(
      samePrivateComputeIntent(next, {
        ...next,
        limits: { ...next.limits, observedAt: "2026-11-04T12:00:00.000Z" },
        checkPolicy: { ...next.checkPolicy, beforeSha256: next.checkPolicy.afterSha256 },
      }),
    ).toBe(true);
  });
  it("requires the observed linked team and project rather than model-authored capacity", () => {
    const next = profile();
    expect(() => readPrivateComputeLimits({})).toThrow("team-plan observation");
    expect(() =>
      readPrivateComputeLimits({
        APP_BUILDER_PRIVATE_COMPUTE_LIMITS: JSON.stringify(next.limits),
        VERCEL_TEAM_ID: "team_other",
        VERCEL_PROJECT_ID: next.limits.projectId,
      }),
    ).toThrow("does not match");
    expect(
      readPrivateComputeLimits({
        APP_BUILDER_PRIVATE_COMPUTE_LIMITS: JSON.stringify(next.limits),
        VERCEL_TEAM_ID: next.limits.teamId,
        VERCEL_PROJECT_ID: next.limits.projectId,
      }),
    ).toEqual(next.limits);
  });
});

const hostedState = () => {
  const source = {
    adapter: "arrusted-development-v0",
    eligibilityDigest: "eligible",
    sourcePath: "/repository",
    sourceSha: "a".repeat(40),
    sourceTree: "b".repeat(40),
  } as const;
  return {
    version: APP_BUILDER_WORKFLOW_VERSION,
    phase: "app_spec_accepted",
    appSpec: {
      appId: "example",
      acceptedByCallId: "accepted",
      artifactPath: "prototype/example/app-spec.md",
      artifactRevision: "revision",
      digest: "spec",
    },
    artifacts: [],
    preparedByCallId: "initial-preparation",
    sourceReceipt: {
      ...source,
      contractDigest: "contract",
      digest: "source",
      releaseEnabled: false,
      sourceKind: "existing-repository",
      version: 3,
    },
    workspace: {
      ...source,
      workspaceDigest: "workspace",
      workspaceId: "same",
      workspacePath: "/workspace/repository",
    },
  } satisfies AppBuilderWorkflowState;
};

const retainedHostedState = () =>
  // SAFETY: Hosted refusal reads only the accepted spec and retained profile. The fixture omits unused planning receipts.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- The unused receipt fields are deliberately absent.
  ({
    ...hostedState(),
    phase: "planned",
    proposal: { target: { privateCompute: profile() } },
  }) as unknown as Extract<AppBuilderWorkflowState, { phase: "planned" }>;

const unexpectedSandboxOperation = (): never => {
  throw new Error("Hosted compute planning should not access the sandbox");
};
const sandbox: SandboxSession & { id: string } = {
  id: "same",
  readBinaryFile: unexpectedSandboxOperation,
  readFile: unexpectedSandboxOperation,
  readTextFile: unexpectedSandboxOperation,
  removePath: unexpectedSandboxOperation,
  resolvePath: unexpectedSandboxOperation,
  run: unexpectedSandboxOperation,
  spawn: unexpectedSandboxOperation,
  writeBinaryFile: unexpectedSandboxOperation,
  writeFile: unexpectedSandboxOperation,
  writeTextFile: unexpectedSandboxOperation,
};

describe("hosted private compute planning", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps the ordinary Build on standard compute when the local profile is requested", async () => {
    await contextStorage.run(new ContextContainer(), async () => {
      const state = hostedState();
      const getProvider = vi.spyOn(previewProvider, "getVercelPreviewProvider");
      appBuilderWorkflowState.update(() => state);
      await expect(
        preparePrivateComputePlanning({
          state,
          sandbox,
          callId: "plan",
          requested: PRIVATE_COMPUTE_PROFILE_ID,
        }),
      ).resolves.toBeUndefined();
      expect(getProvider).not.toHaveBeenCalled();
      expect(appBuilderWorkflowState.get()).toEqual(hostedState());
    });
  });

  it("keeps rejecting an explicit checker request in an unsupported local launch", async () => {
    vi.stubEnv("VERCEL", "0");
    vi.stubEnv("APP_BUILDER_EXECUTION_BUNDLE", "");
    const getProvider = vi.spyOn(previewProvider, "getVercelPreviewProvider");
    await expect(
      preparePrivateComputePlanning({
        state: hostedState(),
        sandbox,
        callId: "plan",
        requested: PRIVATE_COMPUTE_PROFILE_ID,
      }),
    ).rejects.toThrow("requires the supported local Builder launch");
    expect(getProvider).not.toHaveBeenCalled();
  });

  it.each([
    ["a retained profile", () => ({ state: retainedHostedState() })],
    [
      "a repair request",
      () => ({
        state: hostedState(),
        requested: PRIVATE_COMPUTE_PROFILE_ID,
        repairChanges: [{ path: profile().checkPolicy.path, content: PRIVATE_COMPUTE_CHECK_TASK }],
      }),
    ],
  ] as const)(
    "rejects %s before changing planning or looking up a provider",
    async (_, fixture) => {
      await contextStorage.run(new ContextContainer(), async () => {
        const input = fixture();
        const before = structuredClone(input.state);
        const getProvider = vi.spyOn(previewProvider, "getVercelPreviewProvider");
        appBuilderWorkflowState.update(() => input.state);
        await expect(
          preparePrivateComputePlanning({ ...input, sandbox, callId: "plan" }),
        ).rejects.toThrow("requires the supported local Builder launch");
        expect(getProvider).not.toHaveBeenCalled();
        expect(appBuilderWorkflowState.get()).toEqual(before);
      });
    },
  );
});
