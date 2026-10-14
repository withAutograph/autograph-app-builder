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
        try {
          const observed = await launcher.inspect({
            ...input.effect,
            ...prepared,
            readbackOnly: true,
          });
          await assertCurrent(input);
          if (observed?.status === "applied") {
            return "applied";
          }
          if (observed?.status === "absent") {
            return "absent";
          }
          return "unknown";
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
