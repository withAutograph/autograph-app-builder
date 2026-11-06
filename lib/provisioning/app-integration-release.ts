import {
  appIntegrationCentralReferenceMatches,
  readAppIntegrationCentralReference,
} from "./app-integration-central-reference";
import type { ReadExistingPlatformIntegrationReady } from "./app-integration-central-reference";
import type { AppIntegrationCapabilityRow } from "./app-integration-capability-store";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { openHostedPostgresDatabase } from "../mcp/hosted-route";
import type { VercelTokenKeyringConfig } from "../integrations/vercel-installation";
import type { OperatorOwnerContext } from "./hosted-operator-contract";
import type { PublicReleaseRequestAuthority } from "./public-release-dispatcher";
import type { readOwnedBuilderRuntime } from "./owned-builder-runtime";
import type { ReadCentralIntegrationHostReady } from "./app-integration-central-authority";
import { createPostgresAppIntegrationCapabilityStore } from "./app-integration-capability-store";
import { createAppIntegrationCapabilityApprovalAuthority } from "./app-integration-capability-approval";
import { createAppIntegrationPrivateCustody } from "./app-integration-private-custody";
import {
  appIntegrationReleaseAttachmentSchema,
  preparedIntegrationScopeDigest,
} from "./app-integration-release-contract";
import type { AppIntegrationReleaseAttachment } from "./app-integration-release-contract";
import {
  readAppIntegrationCapabilityProfile,
  selectedAppIntegrationCapabilityProfile,
} from "./app-integration-capability-profile";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const unavailable = () => new Error("public_release_integration_capability_unavailable");
const requirePrepared = (row: AppIntegrationCapabilityRow | undefined, digest: string) => {
  if (row === undefined || row.record.prepared === undefined) {
    throw unavailable();
  }
  if (row.record.planDigest !== digest || row.record.approvalReceipts.length === 0) {
    throw unavailable();
  }
  return { capability: row.record.prepared, row };
};
/** A model may select a reference; only the independent approved journal and private custody supply its values. */
export const readAppIntegrationCapabilityForRelease = async (input: {
  database: ReturnType<typeof openHostedPostgresDatabase>;
  keyring: VercelTokenKeyringConfig;
  pointer: { operationRef: string; planDigest: string };
  owner: OperatorOwnerContext;
  authority: PublicReleaseRequestAuthority;
  owned: Awaited<ReturnType<typeof readOwnedBuilderRuntime>>;
  publicOrigin: string;
  builderOrigin: string;
  request: Request;
  assertCurrent: () => Promise<void>;
  readExistingPlatformReady?: ReadExistingPlatformIntegrationReady;
  readCentralReady?: ReadCentralIntegrationHostReady;
  environment: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
}) => {
  await input.assertCurrent();
  const store = createPostgresAppIntegrationCapabilityStore(input.database);
  const observedRow = await store.read(input.owner.authority, input.pointer.operationRef);
  const { row, capability } = requirePrepared(observedRow, input.pointer.planDigest);
  const { plan } = row.record;
  const { owned } = input;
  const selected = owned.description.integrations?.configuration?.find(
    (entry) => entry.provider === "quickbooks",
  );
  const profile = readAppIntegrationCapabilityProfile(input.environment);
  const currentProfile = selectedAppIntegrationCapabilityProfile(profile, plan.selection.appId);
  const matches = [
    input.owner.sessionId === plan.selection.sessionId,
    owned.purpose === "application",
    plan.selection.appId === owned.selection.appId,
    owned.destination.projectId === plan.project.projectId,
    owned.destination.teamId === plan.project.teamId,
    owned.destination.installationId === plan.project.installationId,
    owned.destination.provisioningRequestId === plan.project.provisioningRequestId,
    owned.destination.provisioningDigest === plan.project.provisioningDigest,
    owned.operator.operationRef === plan.runtime.operationRef,
    owned.operator.planDigest === plan.runtime.planDigest,
    owned.selection.releaseId === plan.release.id,
    owned.selection.manifestSha256 === plan.release.manifestSha256,
    owned.selection.appSpecDigest === plan.release.appSpecDigest,
    owned.description.backend.kind === "generated-postgres" &&
      owned.description.backend.release.artifactHash === plan.release.artifactSha256,
    isDeepStrictEqual(
      selected,
      (() => {
        const { artifactRef: sourceReference, ...configuration } = plan.providerConfiguration;
        void sourceReference;
        return configuration;
      })(),
    ),
    isDeepStrictEqual(owned.description.integrations?.machineIngress, plan.machineIngress),
    input.publicOrigin === plan.publicOrigin,
    hash(JSON.stringify(currentProfile)) === plan.profileDigest,
  ];
  if (matches.includes(false)) {
    throw unavailable();
  }
  const central = await readAppIntegrationCentralReference({
    planVersion: plan.version,
    readExisting: input.readExistingPlatformReady,
    readLegacy: input.readCentralReady,
    scope: {
      appId: plan.selection.appId,
      appInstallationId: plan.project.installationId,
      appProjectId: plan.project.projectId,
      assertCurrentOwner: input.assertCurrent,
      authority: input.owner.authority,
      signal: input.request.signal,
      teamId: plan.project.teamId,
    },
  });
  if (
    !appIntegrationCentralReferenceMatches(plan, central) ||
    central.deployment.immutableOrigin !== plan.control.origin ||
    central.caller.projectId !== plan.project.projectId ||
    central.caller.ownerId !== plan.project.teamId
  ) {
    throw unavailable();
  }
  const approval = createAppIntegrationCapabilityApprovalAuthority({
    assertCurrentOwner: input.assertCurrent,
    authority: input.authority,
    builderOrigin: input.builderOrigin,
    database: input.database,
    fetch: input.fetch,
    owner: input.owner,
    request: input.request,
  });
  for (const receipt of row.record.approvalReceipts) {
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Each retained committed approval is independently re-read and may revoke capability custody.
    const actual = await approval(plan, receipt.approvedByCallId);
    if (!isDeepStrictEqual(actual, receipt)) {
      throw unavailable();
    }
  }
  const appScope = {
    appId: plan.selection.appId,
    authority: plan.authority,
    controlNeon: plan.control.neon,
    controlResource: plan.control.database,
    projectId: plan.project.projectId,
    provisioningDigest: plan.project.provisioningDigest,
    provisioningRequestId: plan.project.provisioningRequestId,
    resourceProfileId: plan.control.resourceProfileId,
  };
  const custody = createAppIntegrationPrivateCustody({
    app: appScope,
    assertCurrent: input.assertCurrent,
    database: input.database,
    keyring: input.keyring,
  });
  const scopeSha256 = preparedIntegrationScopeDigest(capability);
  const configuration = await custody.read({
    app: appScope,
    checkpoint: `${row.record.planDigest}:${scopeSha256}`,
    purpose: "runtime-configuration",
    version: 1,
  });
  if (
    configuration === undefined ||
    configuration.reference !== capability.privateConfiguration.reference ||
    configuration.sha256 !== capability.privateConfiguration.sha256
  ) {
    throw unavailable();
  }
  const serializedConfiguration = JSON.stringify(configuration.value);
  const privateValue = z
    .object({ reference: z.uuid(), scopeSha256: z.string(), setupProofSecret: z.string().min(32) })
    .parse(configuration.value);
  if (
    privateValue.reference !== configuration.reference ||
    privateValue.scopeSha256 !== scopeSha256
  ) {
    throw unavailable();
  }
  const attachment: AppIntegrationReleaseAttachment = appIntegrationReleaseAttachmentSchema.parse({
    ...input.pointer,
    capability,
    readinessPath: plan.readinessPath,
    scopeSha256,
  });
  await input.assertCurrent();
  const latest = await store.read(input.owner.authority, input.pointer.operationRef);
  if (
    latest === undefined ||
    latest.revision !== row.revision ||
    !isDeepStrictEqual(latest.record, row.record)
  ) {
    throw unavailable();
  }
  return {
    attachment,
    environment: {
      APP_INTEGRATIONS_CAPABILITY: JSON.stringify(capability),
      APP_INTEGRATIONS_RUNTIME_CONFIGURATION: serializedConfiguration,
    },
    serializedConfiguration,
    setupProofSecret: privateValue.setupProofSecret,
  };
};
