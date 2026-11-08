import { toDurableHostedSessionRecord, attachBuilderDestinationRecord } from "../eve/hosted-store";
import type { HostedEveStore } from "../eve/hosted-store";
import type { HostedPrincipal } from "../eve/hosted-auth";
import type { BuilderDestinationEpoch } from "./builder-session-destination-contract";
import { builderProvisionRequestSchema, builderProvisionRequestDigest } from "./contracts";
import type { BuilderProvisionRequest, BuilderProvisionResponse } from "./contracts";
import type { BuilderProvisionAuthority } from "./journal";
import type { BuilderProvisioningDependencies } from "./service";
import type { NativeTargetOnboardingStore } from "./native-target-onboarding-store";
import type { NativeTargetOnboardingRecord } from "./native-target-onboarding-contract";

/** Same normal provisioner, with its durable request selected before the first POST. */
export const createBuilderSessionDestinationService = <
  Dependencies extends Pick<BuilderProvisioningDependencies, "journal">,
>(deps: {
  sessions: Pick<HostedEveStore, "getSession" | "attachBuilderDestination">;
  provisioning: Dependencies;
  execute: (input: {
    authority: BuilderProvisionAuthority;
    request: BuilderProvisionRequest;
    dependencies: Dependencies;
  }) => Promise<BuilderProvisionResponse>;
  assertMember: (principal: HostedPrincipal) => Promise<void>;
  readNativeTarget: (
    key: Parameters<NativeTargetOnboardingStore["read"]>[0],
  ) => Promise<{ record: Pick<NativeTargetOnboardingRecord, "stage"> } | undefined>;
  now?: () => Date;
}) => ({
  async select(input: {
    principal: HostedPrincipal;
    sessionId: string;
    expected: BuilderDestinationEpoch;
    request: BuilderProvisionRequest;
  }) {
    await deps.assertMember(input.principal);
    const stored = await deps.sessions.getSession(input.principal, input.sessionId);
    if (stored === null || deps.sessions.attachBuilderDestination === undefined) {
      throw new Error("Builder session destination is unavailable.");
    }
    const session = toDurableHostedSessionRecord(stored);
    const request = builderProvisionRequestSchema.parse(input.request);
    if (request.operation !== "vercel" || session.appId === undefined) {
      throw new Error("Select a Vercel destination for this app.");
    }
    if (session.builderDestination === undefined && request.deploymentAccess !== "public-app") {
      throw new Error("Review public app delivery before creating its destination.");
    }
    const { appId } = session;
    const authority = {
      issuer: input.principal.issuer,
      audience: input.principal.audience,
      workspaceId: input.principal.workspaceId,
      ownerUserId: input.principal.ownerUserId,
    };
    const assertNoLegacyEffects = async () => {
      const legacy = await deps.readNativeTarget({ authority, appId });
      if (legacy !== undefined && ["creating", "unknown", "ready"].includes(legacy.record.stage)) {
        throw new Error(
          "Reconcile this app’s existing destination operation before selecting another destination.",
        );
      }
    };
    await assertNoLegacyEffects();
    const destination = {
      appId: session.appId,
      requestId: request.requestId,
      requestDigest: builderProvisionRequestDigest(request),
    };
    // Check visible consent/epoch before reserving even this metadata-only operation.
    attachBuilderDestinationRecord(session, {
      expected: input.expected,
      destination,
      nowEpochMs: (deps.now?.() ?? new Date()).getTime(),
    });
    const row = await deps.provisioning.journal.reserve({
      authority,
      request,
      now: deps.now?.() ?? new Date(),
    });
    if (
      row.requestDigest !== destination.requestDigest ||
      row.record.response.appId !== session.appId
    ) {
      throw new Error("The provisioning request does not belong to this app.");
    }
    await deps.assertMember(input.principal);
    await deps.sessions.attachBuilderDestination({
      principal: input.principal,
      sessionId: input.sessionId,
      expected: input.expected,
      destination,
      nowEpochMs: (deps.now?.() ?? new Date()).getTime(),
    });
    const assertCurrent = async () => {
      await deps.assertMember(input.principal);
      await assertNoLegacyEffects();
      await deps.sessions.attachBuilderDestination?.({
        principal: input.principal,
        sessionId: input.sessionId,
        expected: input.expected,
        destination,
        nowEpochMs: (deps.now?.() ?? new Date()).getTime(),
      });
    };
    const guardedDependencies = { ...deps.provisioning, assertCurrent };
    await assertCurrent();
    if (request.providers.githubInstallationId !== undefined) {
      const repository = await deps.execute({
        authority,
        request: { ...request, operation: "github" },
        dependencies: guardedDependencies,
      });
      if (repository.github.status !== "succeeded") {
        return { sessionId: input.sessionId, destination, provisioning: repository };
      }
    }
    await assertCurrent();
    const provisioning = await deps.execute({
      authority,
      request,
      dependencies: guardedDependencies,
    });
    return { sessionId: input.sessionId, destination, provisioning };
  },
});
