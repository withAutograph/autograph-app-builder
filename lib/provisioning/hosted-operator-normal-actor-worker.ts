import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { getVercelOidcToken } from "@vercel/oidc";
import {
  HostedOperatorError,
  selectHostedOperatorOwnedOrganizationSpec,
  sameOperatorSelection,
} from "./hosted-operator-contract";
import type {
  HostedOperatorOwnedOrganizationSpec,
  HostedOperatorPlan,
} from "./hosted-operator-contract";
import type { NormalActorOperationsDependencies } from "./hosted-operator-normal-actor-operations";
import type { NormalActorAccountPreparation } from "./hosted-operator-normal-actor-journal";
import { normalActorProgramDigest } from "./hosted-operator-normal-actor-program";
import type { NormalActorSessionRef } from "./hosted-operator-normal-actor-program";
import type { HostedOperatorContext, HostedOperatorEffectContext } from "./hosted-operator-service";
import { createHostedOperatorSandboxLauncher } from "./hosted-operator-sandbox-launcher";
import type { GeneratedAppReleaseFiles } from "./hosted-operator-sandbox-launcher";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
import type { ApprovedMembershipInspection } from "./hosted-operator-membership-inspection";

type OrganizationWorkerInput = Parameters<
  NormalActorOperationsDependencies["inspectOrganization"]
>[0];
export interface NormalActorOrganizationWorkerDependencies {
  configuration: Pick<HostedOperatorSourceConfiguration, "sandbox" | "operator" | "teamId">;
  /** Canonical owner and actual current full-plan approval; the retained reader separately checks the first account approval. */
  assertAuthorized: (effect: HostedOperatorEffectContext) => Promise<void>;
  readResourceBindings: (effect: HostedOperatorEffectContext) => Promise<{
    appDatabase: { migrationUrl: string; runtimeUrl: string };
    authDatabase: { migrationUrl: string; runtimeUrl: string };
  }>;
  readGeneratedRelease: (
    context: HostedOperatorContext,
    release: HostedOperatorPlan["release"],
  ) => Promise<{ artifactRef: string; files: GeneratedAppReleaseFiles }>;
  /** Actual first-account approval, retained per-org specification and private immutable artifact bytes. */
  readOrganizationProof: (
    context: HostedOperatorContext,
    input: { organizationId: string; owner: NormalActorSessionRef },
  ) => Promise<{
    preparation: NormalActorAccountPreparation;
    spec: HostedOperatorOwnedOrganizationSpec;
    proof: string;
  }>;
  /** Canonical original approvals, exclusively for SELECT-only inspection. */
  readMembershipInspections: (
    effect: HostedOperatorEffectContext,
    selected: { organizationId: string },
  ) => Promise<readonly ApprovedMembershipInspection[]>;
  readMembershipInspectionProof: (
    effect: HostedOperatorEffectContext,
    inspection: ApprovedMembershipInspection,
    selected: { organizationId: string },
  ) => Promise<{ proof: string; preparation: NormalActorAccountPreparation }>;
}
interface TestDependencies {
  createLauncher?: typeof createHostedOperatorSandboxLauncher;
  getOidcToken?: typeof getVercelOidcToken;
}
const mismatch = () => new HostedOperatorError("resource_mismatch");
const unavailable = () => new HostedOperatorError("operator_unavailable");
const privateOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HostedOperatorError) {
      throw error;
    }
    throw unavailable();
  }
};
const selectedSpec = (input: OrganizationWorkerInput) => {
  const { effect } = input;
  const program = effect.plan.normalActorProgram;
  if (program === undefined || effect.plan.authMembership === undefined) {
    throw mismatch();
  }
  if (
    ![
      effect.effect.kind === "auth-membership",
      effect.effect.id === `auth-membership:${input.organizationId}`,
      effect.plan.stage === "app",
      sameOperatorSelection(effect.plan.selection, effect.target),
    ].every(Boolean)
  ) {
    throw mismatch();
  }
  const organization = program.organizations.find(
    (entry) => entry.organizationId === input.organizationId,
  );
  if (organization === undefined) {
    throw mismatch();
  }
  const spec = selectHostedOperatorOwnedOrganizationSpec(effect.plan.authMembership, {
    organizationId: input.organizationId,
  });
  if (
    ![
      spec.actorId === input.owner.actorId,
      spec.identityCapture.realmSessionId === input.owner.realmSessionId,
      input.owner.origin === program.origin,
      spec.identityProof.reference === input.ownerProof.reference,
      spec.identityProof.sha256 === input.ownerProof.sha256,
      input.ownerProof.actorId === input.owner.actorId,
      input.ownerProof.realmSessionId === input.owner.realmSessionId,
    ].every(Boolean)
  ) {
    throw mismatch();
  }
  return spec;
};
const assertRetained = (
  input: OrganizationWorkerInput,
  spec: HostedOperatorOwnedOrganizationSpec,
  retained: Awaited<ReturnType<NormalActorOrganizationWorkerDependencies["readOrganizationProof"]>>,
) => {
  const frozen = input.effect.plan.normalActorPreparation;
  const program = input.effect.plan.normalActorProgram;
  if (frozen === undefined || program === undefined) {
    throw mismatch();
  }
  const { preparation } = retained;
  const declared = preparation.program.organizations.find(
    (entry) => entry.organizationId === input.organizationId,
  );
  const captured = preparation.organizationProofs?.find(
    (entry) => entry.organizationId === input.organizationId,
  );
  if (captured === undefined) {
    throw mismatch();
  }
  const same = [
    frozen.accountOperationRef === preparation.accountOperationRef,
    frozen.accountPlanDigest === preparation.accountPlanDigest,
    frozen.accountApprovalId === preparation.accountApprovalId,
    frozen.accountApprovedByCallId === preparation.accountApprovedByCallId,
    frozen.programDigest === preparation.programDigest,
    normalActorProgramDigest(program) === preparation.programDigest,
    isDeepStrictEqual(spec, retained.spec),
    captured.ownerActorKey === declared?.ownerActorKey,
    captured.owner.actorId === input.owner.actorId,
    captured.owner.realmSessionId === input.owner.realmSessionId,
    captured.link.proofRef === spec.identityProof.reference,
    captured.link.proofSha256 === spec.identityProof.sha256,
    captured.link.nonceSha256 === spec.identityNonceSha256,
    captured.link.bootstrapPlanDigest === spec.bootstrapPlanDigest,
    captured.link.consumedAt === spec.identityCapture.capturedAt,
    captured.link.issuer === spec.identityVerification.issuer,
    captured.link.audience === spec.identityVerification.audience,
    `${captured.link.endpointOrigin}/_platform/jwks.json` === spec.identityVerification.jwksUrl,
    captured.link.ownerSessionId === input.effect.target.sessionId,
    captured.link.organizationId === null,
    isDeepStrictEqual(captured.transportSource, spec.identityVerification.transportSource),
    Buffer.byteLength(retained.proof, "utf-8") <= 16_384,
    createHash("sha256").update(retained.proof, "utf-8").digest("hex") ===
      spec.identityProof.sha256,
    spec.identityProof.reference ===
      `_protected-operator/artifacts/realm-identity-proof/${input.effect.target.appId}/${spec.identityProof.sha256}`,
  ];
  if (!same.every(Boolean)) {
    throw mismatch();
  }
};

type HistoricalMembershipProof = Awaited<
  ReturnType<NormalActorOrganizationWorkerDependencies["readMembershipInspectionProof"]>
>;
const assertHistoricalInspection = (
  input: OrganizationWorkerInput,
  historical: ApprovedMembershipInspection,
  original: HistoricalMembershipProof | undefined,
) => {
  const membership = historical.plan.authMembership;
  if (membership === undefined || original === undefined) {
    throw mismatch();
  }
  const spec = selectHostedOperatorOwnedOrganizationSpec(membership, {
    organizationId: input.organizationId,
  });
  // Historical JWT verification uses capturedAt. The host must retain
  // the actual consumed canonical link, including superseded captures.
  const captured = [
    ...(original.preparation.organizationProofs ?? []),
    ...(original.preparation.supersededOrganizationProofs ?? []),
  ].some((entry) =>
    [
      entry.organizationId === input.organizationId,
      entry.owner.actorId === spec.actorId,
      entry.owner.realmSessionId === spec.identityCapture.realmSessionId,
      entry.owner.origin === spec.identityVerification.issuer,
      entry.link.ownerSessionId === historical.plan.selection.sessionId,
      entry.link.organizationId === null,
      entry.link.authResourceId === historical.plan.authDatabase.resourceId,
      entry.link.browserOrigin === spec.identityVerification.issuer,
      entry.link.proofRef === spec.identityProof.reference,
      entry.link.proofSha256 === spec.identityProof.sha256,
      entry.link.nonceSha256 === spec.identityNonceSha256,
      entry.link.bootstrapPlanDigest === spec.bootstrapPlanDigest,
      entry.link.consumedAt === spec.identityCapture.capturedAt,
      entry.link.issuer === spec.identityVerification.issuer,
      entry.link.audience === spec.identityVerification.audience,
      `${entry.link.endpointOrigin}/_platform/jwks.json` === spec.identityVerification.jwksUrl,
      isDeepStrictEqual(entry.transportSource, spec.identityVerification.transportSource),
    ].every(Boolean),
  );
  const matches = [
    captured,
    historical.effect.kind === "auth-membership",
    ["auth-membership", `auth-membership:${input.organizationId}`].includes(historical.effect.id),
    spec.actorId === input.owner.actorId,
    spec.identityProof.reference ===
      `_protected-operator/artifacts/realm-identity-proof/${input.effect.target.appId}/${spec.identityProof.sha256}`,
    Buffer.byteLength(original.proof, "utf-8") <= 16_384,
    createHash("sha256").update(original.proof, "utf-8").digest("hex") ===
      spec.identityProof.sha256,
  ];
  if (!matches.every(Boolean)) {
    throw mismatch();
  }
};

/** Real selected organization worker and readback through the deployment-owned launcher. Test overrides have no successful production defaults. */
export const createNormalActorOrganizationWorkers = (
  deps: NormalActorOrganizationWorkerDependencies,
  testing: TestDependencies = {},
): Pick<NormalActorOperationsDependencies, "executeOrganization" | "inspectOrganization"> => {
  const launcher = (testing.createLauncher ?? createHostedOperatorSandboxLauncher)(
    deps.configuration.sandbox,
  );
  const oidc = testing.getOidcToken ?? getVercelOidcToken;
  const assertCurrent = async (input: OrganizationWorkerInput) => {
    await deps.assertAuthorized(input.effect);
    await input.effect.assertCurrent();
  };
  const privateInput = async (input: OrganizationWorkerInput) => {
    await assertCurrent(input);
    const spec = selectedSpec(input);
    const boundary = input.effect.plan.deploymentBoundary;
    if (
      boundary === undefined ||
      boundary.teamId !== deps.configuration.teamId ||
      boundary.operator.projectId !== deps.configuration.operator.projectId
    ) {
      throw mismatch();
    }
    const retained = await deps.readOrganizationProof(input.effect, {
      organizationId: input.organizationId,
      owner: input.owner,
    });
    assertRetained(input, spec, retained);
    await assertCurrent(input);
    const [urls, generatedRelease] = await Promise.all([
      deps.readResourceBindings(input.effect),
      deps.readGeneratedRelease(input.effect, input.effect.plan.release),
    ]);
    if (generatedRelease.artifactRef !== input.effect.plan.release.artifactRef) {
      throw mismatch();
    }
    await assertCurrent(input);
    const oidcToken = await oidc({
      project: deps.configuration.operator.projectId,
      team: deps.configuration.teamId,
    });
    if (oidcToken.length === 0) {
      throw unavailable();
    }
    await assertCurrent(input);
    return {
      database: "authDatabase" as const,
      directDatabaseUrl: urls.authDatabase.migrationUrl,
      accessConnections: {
        appMigrator: urls.appDatabase.migrationUrl,
        appRuntime: urls.appDatabase.runtimeUrl,
        authMigrator: urls.authDatabase.migrationUrl,
        authRuntime: urls.authDatabase.runtimeUrl,
      },
      generatedRelease,
      membershipProof: { proof: retained.proof, oidcToken, organizationId: input.organizationId },
    };
  };
  return {
    async executeOrganization(input) {
      await privateOperation(async () => {
        const prepared = await privateInput(input);
        await launcher.execute({ ...input.effect, ...prepared });
        await assertCurrent(input);
      });
    },
    async inspectOrganization(input) {
      return await privateOperation(async () => {
        const prepared = await privateInput(input);
        const currentFence = async () => {
          await assertCurrent(input);
        };
        const inspect = async (
          historical?: ApprovedMembershipInspection,
          original?: HistoricalMembershipProof,
        ) => {
          if (historical !== undefined) {
            assertHistoricalInspection(input, historical, original);
          }
          await assertCurrent(input);
          const observed = await launcher.inspect({
            ...input.effect,
            ...prepared,
            ...(historical === undefined || original === undefined
              ? {}
              : {
                  plan: historical.plan,
                  effect: historical.effect,
                  membershipProof: { ...prepared.membershipProof, proof: original.proof },
                }),
            // Only the observed marker uses historical plan bytes. Authority and
            // every execution fence still belong to the current approved effect.
            assertCurrent: currentFence,
            readbackOnly: true,
          });
          await assertCurrent(input);
          return observed?.status;
        };
        try {
          const historical = await deps.readMembershipInspections(input.effect, {
            organizationId: input.organizationId,
          });
          for (const candidate of historical) {
            // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Each candidate must recheck the same live owner and journal fence before private reads.
            await assertCurrent(input);
            try {
              // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Original proof reads share the current authority journal and precede their selected worker inspection.
              const original = await deps.readMembershipInspectionProof(input.effect, candidate, {
                organizationId: input.organizationId,
              });
              // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Inspect one authorized marker at a time under the shared fence and stop on its exact live match.
              if ((await inspect(candidate, original)) === "applied") {
                return "applied";
              }
            } catch (error) {
              if (
                !(error instanceof HostedOperatorError) ||
                ![
                  "reconciliation_required",
                  "auth_identity_required",
                  "resource_mismatch",
                ].includes(error.code)
              ) {
                throw error;
              }
            }
          }
          if (historical.length > 0) {
            // Missing historical state never authorizes recreation under any plan.
            await assertCurrent(input);
            return "unknown";
          }
          const status = await inspect();
          return status === "applied" || status === "absent" ? status : "unknown";
        } catch (error) {
          if (error instanceof HostedOperatorError && error.code === "reconciliation_required") {
            return "unknown";
          }
          throw error;
        }
      });
    },
  };
};
