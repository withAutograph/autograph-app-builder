import { describe, expect, it, vi } from "vitest";
import { durableHostedSessionRecordSchema } from "../eve/hosted-store";
import { hostedRuntimeTargetSchema } from "./hosted-runtime-journal";
import { compiledOperatorReleaseSelectionSchema } from "./hosted-operator-artifact-selection";
import { readOwnedOperatorPlanningSelection } from "./hosted-operator-planning-authority";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const target = hostedRuntimeTargetSchema.parse({
  appId: "spend-review",
  branch: "feature",
  environment: "preview",
  installationId: "icfg_1",
  projectId: "prj_app",
  scopeId: "team_1",
  scopeType: "team",
  sessionId: "public-session",
});
const context = { authority, target };
const currentSpec = {
  appId: "spend-review",
  appSpecDigest: "a".repeat(64),
  sessionId: "adapter-session",
  workspaceId: "workspace",
};
const selected = compiledOperatorReleaseSelectionSchema.parse({
  appId: "spend-review",
  appSpecDigest: currentSpec.appSpecDigest,
  artifactRef: `_protected-operator/artifacts/generated-release/spend-review/${"b".repeat(64)}`,
  manifestSha256: "c".repeat(64),
  releaseId: "v19",
  schemaSha256: "d".repeat(64),
  version: 1,
});
const fixture = () => {
  const session = durableHostedSessionRecordSchema.parse({
    adapterGeneration: 1,
    adapterSessionId: "adapter-session",
    appId: target.appId,
    createdAtEpochMs: 1,
    lastProgressAtEpochMs: 1,
    originAdapterSessionId: "adapter-session",
    principal: { ...authority, scopes: ["autograph:session"] },
    privateBuildDecision: {
      adapterSessionId: "adapter-session",
      currentSpec,
      decision: "blocked",
      turnId: "turn",
      turnSequence: 1,
      version: 1,
      workflowPhase: "applied",
    },
    resumability: "live",
    sessionId: "public-session",
    stage: "ready",
    status: "waiting",
    title: "Owned app",
    updatedAtEpochMs: 1,
    version: 2,
  });
  const readCurrentPlanningOwner = vi.fn(
    async () => await Promise.resolve({ session: structuredClone(session), target }),
  );
  const readGeneratedSelection = vi.fn(async () => await Promise.resolve(selected));
  return { controlPlane: { readCurrentPlanningOwner, readGeneratedSelection }, session };
};

describe("real owner-scoped planning projection", () => {
  it("reads the actual accepted digest in the canonical public artifact namespace", async () => {
    const f = fixture();
    expect(
      await readOwnedOperatorPlanningSelection({ context, controlPlane: f.controlPlane }),
    ).toMatchObject({ currentSpec, selection: selected });
    expect(f.controlPlane.readGeneratedSelection).toHaveBeenCalledWith(
      context,
      currentSpec.appSpecDigest,
    );
    expect(f.controlPlane.readCurrentPlanningOwner).toHaveBeenCalledTimes(2);
  });
  it.each(["appId", "sessionId", "workspaceId"] as const)(
    "denies a cross-scope accepted %s",
    async (field) => {
      const f = fixture();
      const decision = f.session.privateBuildDecision;
      if (decision?.currentSpec === undefined) {
        throw new Error("Missing fixture projection");
      }
      decision.currentSpec[field] = "foreign";
      await expect(
        readOwnedOperatorPlanningSelection({ context, controlPlane: f.controlPlane }),
      ).rejects.toMatchObject({ code: "operator_unavailable" });
      expect(f.controlPlane.readGeneratedSelection).not.toHaveBeenCalled();
    },
  );
  it("requires actual private accepted state without a latest-artifact fallback", async () => {
    const f = fixture();
    delete f.session.privateBuildDecision;
    await expect(
      readOwnedOperatorPlanningSelection({ context, controlPlane: f.controlPlane }),
    ).rejects.toThrow();
    expect(f.controlPlane.readGeneratedSelection).not.toHaveBeenCalled();
  });
  it("keeps a coherent source snapshot when ordinary accepted edits arrive during planning", async () => {
    const f = fixture();
    f.controlPlane.readGeneratedSelection.mockImplementation(async () => {
      const spec = f.session.privateBuildDecision?.currentSpec;
      if (spec === undefined) {
        throw new Error("Missing fixture projection");
      }
      spec.appSpecDigest = "e".repeat(64);
      return await Promise.resolve(selected);
    });
    const result = await readOwnedOperatorPlanningSelection({
      context,
      controlPlane: f.controlPlane,
    });
    expect(result.currentSpec.appSpecDigest).toBe(currentSpec.appSpecDigest);
    expect(result.selection).toEqual(selected);
  });
});
