/* oxlint-disable eslint/require-await -- Closed async provider/SDK fixtures exercise actual production composition and restricted SQL. */
import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import { z } from "zod";
import type { openHostedPostgresDatabase } from "../../../../../lib/mcp/hosted-route";
import type { VercelTokenKeyringConfig } from "../../../../../lib/integrations/vercel-installation";
import {
  encryptVercelToken,
  vercelInstallationTokenAssociatedData,
} from "../../../../../lib/integrations/vercel-installation";
import { hostedVercelInstallations, hostedGitHubInstallations } from "../../../../../lib/db/schema";
import { centralPrivateProfileFixture } from "../../../../../lib/provisioning/central-integration-private-profile-test-fixture";
import {
  centralHostCanonicalBytes,
  centralHostSetupPlanSchema,
  centralHostOperationRef,
  centralHostPlanDigest,
  centralHostCallerPlanSchema,
} from "../../../../../lib/provisioning/central-integration-host-contract";
import { operatorOwnerContextSchema } from "../../../../../lib/provisioning/hosted-operator-contract";
import { centralTrustedSourcesSchema } from "../../../../../lib/provisioning/central-integration-vercel-provider";
import { centralHostRecordSchema } from "../../../../../lib/provisioning/central-integration-host-store";
import type { CentralHostSetupPlan } from "../../../../../lib/provisioning/central-integration-host-contract";
import { createCentralIntegrationReceiptDeploymentHandler } from "../../../../../lib/provisioning/central-integration-receipt-deployment";
import { createCentralHostDeployment } from "../../../../../lib/provisioning/central-integration-host-deployment";

/** Real native factory/dispatcher + restricted SQL + private sealing. Provider/SDK transport remains a closed synthetic boundary. */
export const proveCentralNativeComposition = async (input: {
  database: ReturnType<typeof openHostedPostgresDatabase>;
  adminDatabase: ReturnType<typeof openHostedPostgresDatabase>;
  databaseUrl: string;
  keyring: VercelTokenKeyringConfig;
}) => {
  const originalProfile = centralPrivateProfileFixture();
  const profile = {
    ...originalProfile,
    source: { ...originalProfile.source, repositoryId: "123", installationId: "456" },
  };
  const authority = profile.owners[0];
  const owner = operatorOwnerContextSchema.parse({
    kind: "direct",
    authority,
    principal: { ...authority, scopes: ["autograph:get"] },
    sessionId: "central-composition-session",
    adapterSessionId: "central-composition-adapter",
    adapterGeneration: 1,
  });
  const encrypted = encryptVercelToken({
    token: "synthetic-vercel-token",
    key: input.keyring.tokenKey,
    associatedData: vercelInstallationTokenAssociatedData(authority, profile.target.installationId),
  });
  await input.adminDatabase.insert(hostedVercelInstallations).values({
    ...authority,
    ...encrypted,
    active: true,
    displayName: "Isolated proof",
    installationId: profile.target.installationId,
    plan: "fixture",
    scopeId: profile.target.teamId,
    scopeType: "team",
    slug: "owned-proof",
    tokenKeyVersion: input.keyring.tokenKeyVersion,
    updatedAt: new Date(),
  });
  const revisionOwner = operatorOwnerContextSchema.parse({
    ...owner,
    sessionId: "separate-revision-session",
    adapterSessionId: "separate-revision-adapter",
  });
  const normal = {
    projectId: "actual-normal-app-project",
    teamId: profile.target.teamId,
    installationId: "app-installation",
    provisioningRequestId: "55555555-5555-4555-a555-555555555555",
    provisioningDigest: "a".repeat(64),
  };
  await input.adminDatabase.insert(hostedGitHubInstallations).values({
    ...authority,
    accountId: "987",
    accountLogin: "owned",
    accountType: "Organization",
    active: true,
    installationId: profile.source.installationId,
    updatedAt: new Date(),
  });
  let sources = centralTrustedSourcesSchema.parse({ projects: {} });
  let nativeEvents: unknown[] = [];
  const manifestSchema = z.record(z.string(), z.json());
  interface LoadedCentralConfiguration {
    manifest?: z.infer<typeof manifestSchema>;
  }
  const loaded: LoadedCentralConfiguration = {};
  const nativeId = "accepted-native-central-id";
  const nativeOrigin = "https://accepted-native-central.vercel.app";
  let authorized = true;
  let sourceInspections = 0;
  let providerWrites = 0;
  const assertCurrent = () => {
    assert.ok(authorized, "revoked owner");
    return Promise.resolve();
  };
  const deployment = createCentralHostDeployment({
    database: input.database,
    databaseUrl: input.databaseUrl,
    keyring: input.keyring,
    builderOrigin: profile.receiver.publicOrigin,
    environment: {
      HOSTED_CENTRAL_INTEGRATIONS_CONFIGURATION: JSON.stringify(profile),
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export(
        { format: "pem", type: "pkcs8" },
      ),
    },
    configuration: {
      builderCallbackOrigin: profile.receiver.publicOrigin,
      operator: {
        projectId: profile.inspector.projectId,
        environment: "preview",
        deploymentId: "operator-current",
        origin: "https://operator.example",
      },
      sandbox: {
        image: "synthetic-source-image",
        projectId: profile.inspector.projectId,
        teamId: profile.target.teamId,
        workers: {},
        centralIntegrationWorker: {
          ...profile.source.workers.schema,
          operationScope: "central-integration-bootstrap-v1",
          executablePath: "/worker/central",
          subcommand: "central-integration-schema",
        },
      },
    },
    owner: {
      verifyWorkload: async (request) => {
        await assertCurrent();
        assert.equal(request.headers.get("authorization"), "Bearer synthetic-workload");
      },
      assertCanonicalAppOwner: async (actual) => {
        await assertCurrent();
        assert.deepEqual(actual.authority, authority);
        assert.equal(actual.target.appId, "composition-app");
        assert.ok([owner.sessionId, revisionOwner.sessionId].includes(actual.target.sessionId));
      },
      readStandardDestination: async () => {
        await assertCurrent();
        return normal;
      },
    },
    readSourceOwner: async (_authority, target) => {
      await assertCurrent();
      return target.sessionId === revisionOwner.sessionId ? revisionOwner : owner;
    },
    readInspectorToken: async () => "synthetic-inspector-oidc-token",
    fetch: async (url, init) => {
      await assertCurrent();
      if (init?.method !== undefined && init.method !== "GET") providerWrites += 1;
      const target = new URL(z.union([z.string(), z.instanceof(URL)]).parse(url));
      if (target.hostname === "api.github.com") {
        if (target.pathname === "/app/installations/456/access_tokens")
          return Response.json({
            token: "synthetic-installation-token",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            permissions: { contents: "write", metadata: "read" },
            repository_selection: "selected",
            repositories: [{ id: 123 }],
          });
        if (target.pathname === "/repositories/123")
          return Response.json({ id: 123, full_name: "owned/central" });
        if (
          target.pathname === `/repos/owned/central/git/commits/${profile.source.reviewedSourceSha}`
        )
          return Response.json({ sha: profile.source.reviewedSourceSha });
        if (target.pathname.startsWith("/repos/owned/central/git/ref/heads/"))
          return new Response(null, { status: 404 });
        throw new Error("unexpected GitHub effect");
      }
      if (target.pathname.includes("/eve/v1/session/")) {
        const start = Number(target.searchParams.get("startIndex") ?? 0);
        const sessionId = target.pathname.split("/").at(-2);
        return new Response(
          nativeEvents
            .slice(start)
            .map((event) => JSON.stringify(event))
            .join("\n") + "\n",
          {
            headers: {
              "content-type": "application/x-ndjson",
              "x-eve-session-id": sessionId ?? "invalid",
              "x-eve-stream-format": "ndjson",
              "x-eve-stream-version": "25",
              "x-eve-stream-tail-index": String(nativeEvents.length - 1),
            },
          },
        );
      }
      if (target.pathname === `/v13/deployments/${nativeId}`)
        return Response.json({
          id: nativeId,
          projectId: profile.target.projectId,
          target: null,
          url: new URL(nativeOrigin).host,
          readyState: "READY",
          gitSource: { sha: profile.source.reviewedSourceSha },
        });
      if (target.pathname === "/integrations/internal/central-readiness") {
        const manifest = loaded.manifest;
        assert.ok(manifest !== undefined);
        return Response.json({
          version: 1,
          kind: "central-integrations-readiness-v1",
          ...manifest,
          centralPrincipalGeneration: 7,
          deployment: {
            ...z.record(z.string(), z.unknown()).parse(manifest.deployment),
            providerDeploymentId: nativeId,
            immutableOrigin: nativeOrigin,
          },
        });
      }
      if (target.pathname.endsWith("/env")) return Response.json({ envs: [] });
      if (target.pathname === `/v9/projects/${normal.projectId}`)
        return Response.json({ id: normal.projectId, accountId: normal.teamId });
      assert.equal(target.pathname, `/v9/projects/${profile.target.projectId}`);
      return Response.json({
        id: profile.target.projectId,
        accountId: profile.target.teamId,
        framework: "services",
        rootDirectory: ".",
        link: { type: "github", repoId: profile.source.repositoryId },
        oidcTokenConfig: { enabled: true, issuerMode: "team" },
        trustedSources: sources,
      });
    },
    runSourceCapture: async (_configuration, request) => {
      sourceInspections += 1;
      assert.equal(request.readOnly, true);
      assert.equal(request.context.kind, "central_source_capture");
      assert.equal(Object.keys(request.startupFiles).length, 1);
      const receipt = {
        sourceSha: profile.source.reviewedSourceSha,
        deploymentProfile: profile.source.deploymentProfile,
        serviceIds: profile.source.serviceIds,
        servicesManifestSha256: profile.source.servicesManifestSha256,
        workers: profile.source.workers,
      };
      return {
        version: 1,
        operation_id: request.context.operation.operation_id,
        context_digest: "a".repeat(64),
        fence_generation: 1,
        status: "applied",
        receipt,
        readback_sha256: createHash("sha256")
          .update(centralHostCanonicalBytes(z.json().parse(receipt)))
          .digest("hex"),
      };
    },
  });
  const request = () =>
    new Request("https://operator.example/v1/central-integrations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer synthetic-workload" },
      body: JSON.stringify({
        action: "central-integration-host-plan",
        ownerContext: owner,
        adapterSessionId: owner.adapterSessionId,
        callId: "actual-plan-call",
        execution: { logicalSessionId: owner.adapterSessionId },
        input: { kind: "setup", appId: "composition-app" },
      }),
    });
  const first = await deployment.request(request());
  assert.equal(first.status, 200);
  const result = z.object({ plan: centralHostSetupPlanSchema }).parse(await first.json());
  const stored = await deployment.store.read(authority, centralHostOperationRef(result.plan));
  assert.ok(stored);
  assert.deepEqual(stored.record.plan, result.plan);
  assert.equal(providerWrites, 0);
  assert.equal(sourceInspections, 1);
  const restarted = await deployment.request(request());
  assert.equal(restarted.status, 200);
  assert.deepEqual(await restarted.json(), {
    plan: result.plan,
    operationRef: stored.operationRef,
    planDigest: stored.record.planDigest,
  });
  assert.equal(sourceInspections, 2);
  assert.equal(providerWrites, 0);
  const privateValues = await deployment.frozen(
    { authority, sessionId: owner.sessionId, callId: "read", signal: new AbortController().signal },
    result.plan,
  );
  assert.equal(Object.keys(privateValues.values).length, 12);
  assert.equal(JSON.stringify(stored.record).includes("synthetic-vercel-token"), false);
  const setupPlan = result.plan;
  loaded.manifest = manifestSchema.parse(
    JSON.parse(privateValues.values.INTEGRATIONS_CENTRAL_CONFIGURATION ?? "null"),
  );
  const grants = { customAllow: [{ from: { slugs: ["preview"] }, to: { slugs: ["preview"] } }] };
  sources = centralTrustedSourcesSchema.parse({
    projects: {
      [profile.inspector.projectId]: grants,
      [normal.projectId]: {
        customAllow: [{ from: { slugs: ["production"] }, to: { slugs: ["preview"] } }],
      },
    },
  });
  const receipts = {
    "prepare-central-resources": {
      effect: "prepare-central-resources",
      resourceId: setupPlan.control.resource.resourceId,
      resourceVersion: "verified",
      readbackSha256: "a".repeat(64),
    },
    "install-central-schema": {
      effect: "install-central-schema",
      resourceProfileId: setupPlan.resourceProfileId,
      schemaSha256: setupPlan.control.schemaSha256,
      configurationSha256: setupPlan.source.configurationSha256,
      centralPrincipalGeneration: 7,
    },
    "register-deployment-receiver": {
      effect: "register-deployment-receiver",
      id: "accepted-hook",
      secretSha256: "a".repeat(64),
    },
    "authorize-central-inspector": {
      effect: "authorize-central-inspector",
      projectId: setupPlan.target.projectId,
      callerProjectId: setupPlan.inspector.projectId,
      environment: "preview",
      targetEnvironment: "preview",
      trustedSourcesSha256: "a".repeat(64),
      trustedSourcesGrantSha256: "b".repeat(64),
    },
    "bind-central-preview-runtime": {
      effect: "bind-central-preview-runtime",
      environmentSha256: "a".repeat(64),
    },
    "publish-central-host-source": {
      effect: "publish-central-host-source",
      repositoryId: setupPlan.source.repositoryId,
      branch: setupPlan.source.operationBranch,
      sourceSha: setupPlan.source.reviewedSourceSha,
    },
  };
  const event = {
    eventId: "provider-created",
    eventType: "deployment.created",
    bodySha256: "a".repeat(64),
    projectId: setupPlan.target.projectId,
    teamId: setupPlan.target.teamId,
    providerDeploymentId: nativeId,
    immutableOrigin: nativeOrigin,
  };
  const setupRecord = centralHostRecordSchema.parse({
    ...stored.record,
    effects: Object.fromEntries(setupPlan.effects.map((effect) => [effect, "applied"])),
    executionLease: { leaseId: "33333333-3333-4333-a333-333333333333", fenceGeneration: 7 },
    attempts: Object.fromEntries(
      setupPlan.effects.map((effect) => [
        effect,
        {
          attemptId: "44444444-4444-4444-a444-444444444444",
          attemptGeneration: 7,
          receipt: receipts[effect],
        },
      ]),
    ),
    approvalReceipts: [
      { approvedByCallId: "original-setup-call", approvedAt: "2026-11-03T00:00:01Z" },
    ],
    nativeDeployment: {
      status: "accepted",
      providerDeploymentId: nativeId,
      immutableOrigin: nativeOrigin,
      events: [event],
    },
  });
  assert.ok(await deployment.store.compareAndSet(stored, setupRecord));
  const receiverSecret = randomBytes(32).toString("hex");
  await privateValues.custody.recordAcceptedReceiver({
    subscriptionRef: setupPlan.receiver.subscriptionRef,
    id: "provider-accepted-hook",
    secret: receiverSecret,
    secretSha256: createHash("sha256").update(receiverSecret).digest("hex"),
  });
  const rawEvent = JSON.stringify({
    id: "relayed-created",
    type: "deployment.created",
    privateMarker: "never-retain-raw-provider-body",
    payload: {
      project: { id: setupPlan.target.projectId },
      team: { id: setupPlan.target.teamId },
      target: null,
      deployment: {
        id: nativeId,
        url: new URL(nativeOrigin).hostname,
        meta: {
          githubCommitRef: setupPlan.source.operationBranch,
          githubCommitSha: setupPlan.source.reviewedSourceSha,
        },
      },
    },
  });
  const signature = createHmac("sha1", receiverSecret).update(rawEvent).digest("hex");
  const relay = createCentralIntegrationReceiptDeploymentHandler(
    { HOSTED_RUNTIME_OPERATOR_URL: "https://operator.example" },
    {
      token: async () => "synthetic-workload",
      fetch: async (url, init) => await deployment.receive(new Request(url, init)),
    },
  );
  const relayed = await relay(
    new Request(new URL(setupPlan.receiver.path, profile.receiver.publicOrigin), {
      method: "POST",
      headers: { "x-vercel-signature": signature },
      body: rawEvent,
    }),
  );
  assert.equal(relayed.status, 200);
  assert.equal(z.object({ code: z.string() }).parse(await relayed.json()).code, "accepted");
  const afterRelay = await deployment.store.read(authority, stored.operationRef);
  assert.ok(afterRelay);
  assert.equal(JSON.stringify(afterRelay.record).includes("never-retain-raw-provider-body"), false);
  assert.equal(JSON.stringify(afterRelay.record).includes(receiverSecret), false);
  const forged = await relay(
    new Request(new URL(setupPlan.receiver.path, profile.receiver.publicOrigin), {
      method: "POST",
      headers: { "x-vercel-signature": "0".repeat(40) },
      body: rawEvent,
    }),
  );
  assert.equal(forged.status, 403);
  const callerPlan = centralHostCallerPlanSchema.parse({
    version: 1,
    kind: "central-integration-host-caller-v1",
    authority,
    selection: { sessionId: owner.sessionId, initiatingAppId: "composition-app" },
    profile: setupPlan.profile,
    setupAuthority: authority,
    setup: { operationRef: stored.operationRef, planDigest: stored.record.planDigest },
    central: {
      projectId: setupPlan.target.projectId,
      teamId: setupPlan.target.teamId,
      installationId: setupPlan.target.installationId,
      providerDeploymentId: nativeId,
      immutableOrigin: nativeOrigin,
      configurationSha256: setupPlan.source.configurationSha256,
    },
    caller: {
      projectId: normal.projectId,
      ownerId: normal.teamId,
      environment: "production",
      targetEnvironment: "preview",
      provisioningRequestId: normal.provisioningRequestId,
      provisioningDigest: normal.provisioningDigest,
      priorGrantSha256: "a".repeat(64),
    },
    effects: ["authorize-app-central-caller"],
  });
  const caller = await deployment.store.reserve(callerPlan);
  const approved = (plan: CentralHostSetupPlan | typeof callerPlan, callId: string) => [
    {
      type: "input.requested",
      meta: { at: "2026-11-03T00:00:00Z", id: `${callId}-request` },
      data: {
        sequence: 1,
        stepIndex: 0,
        turnId: "turn",
        requests: [
          {
            kind: "tool-approval",
            requestId: callId,
            prompt: "Approve exact closed plan",
            action: {
              kind: "tool-call",
              toolName: "prepare-app-central-integrations",
              callId,
              input: {
                plan,
                operationRef: centralHostOperationRef(plan),
                planDigest: centralHostPlanDigest(plan),
              },
            },
          },
        ],
      },
    },
    {
      type: "approval.settled",
      meta: { at: "2026-11-03T00:00:01Z", id: `${callId}-settled` },
      data: {
        sequence: 2,
        stepIndex: 0,
        turnId: "turn",
        requestId: callId,
        responderPrincipalId: authority.ownerUserId,
        outcome: "approved",
      },
    },
  ];
  nativeEvents = [
    ...approved(setupPlan, "original-setup-call"),
    ...approved(callerPlan, "original-caller-call"),
  ];
  const callerApproved = await deployment.store.compareAndSet(caller, {
    ...caller.record,
    effects: { "authorize-app-central-caller": "applied" },
    executionLease: { leaseId: "66666666-6666-4666-a666-666666666666", fenceGeneration: 7 },
    attempts: {
      "authorize-app-central-caller": {
        attemptId: "77777777-7777-4777-a777-777777777777",
        attemptGeneration: 7,
        receipt: {
          effect: "authorize-app-central-caller",
          projectId: setupPlan.target.projectId,
          callerProjectId: normal.projectId,
          environment: "production",
          targetEnvironment: "preview",
          trustedSourcesSha256: "a".repeat(64),
          trustedSourcesGrantSha256: "b".repeat(64),
        },
      },
    },
    approvalReceipts: [
      { approvedByCallId: "original-caller-call", approvedAt: "2026-11-03T00:00:01Z" },
    ],
  });
  assert.ok(callerApproved);
  const observed = await deployment.compose(request(), owner, assertCurrent).observeCaller(
    {
      authority,
      sessionId: owner.sessionId,
      callId: "readonly",
      signal: new AbortController().signal,
    },
    callerApproved,
  );
  assert.ok(observed);
  const canonical = await deployment.store.compareAndSet(callerApproved, {
    ...callerApproved.record,
    observation: observed,
  });
  assert.ok(canonical);
  const revisionRequest = new Request("https://operator.example/v1/central-integrations", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer synthetic-workload" },
    body: JSON.stringify({
      action: "central-integration-host-plan",
      ownerContext: revisionOwner,
      adapterSessionId: revisionOwner.adapterSessionId,
      callId: "revision-plan",
      execution: { logicalSessionId: revisionOwner.adapterSessionId },
      input: { kind: "caller", appId: "composition-app" },
    }),
  });
  const replacementSetupRequest = new Request("https://operator.example/v1/central-integrations", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer synthetic-workload" },
    body: JSON.stringify({
      action: "central-integration-host-plan",
      ownerContext: revisionOwner,
      adapterSessionId: revisionOwner.adapterSessionId,
      callId: "must-resume-original",
      execution: { logicalSessionId: revisionOwner.adapterSessionId },
      input: { kind: "setup", appId: "composition-app" },
    }),
  });
  const replacementDenied = await deployment.request(replacementSetupRequest);
  assert.equal(replacementDenied.status, 409);
  assert.equal(
    z.object({ code: z.string() }).parse(await replacementDenied.json()).code,
    "central_host_setup_recovery_required",
  );
  const revokedRevisionRequest = revisionRequest.clone();
  const reused = await deployment.request(revisionRequest);
  assert.equal(reused.status, 200);
  assert.deepEqual(await reused.json(), {
    status: "ready",
    receipt: observed,
    ...observed.callerSetup,
  });
  const retainedCaller = await deployment.store.readReadyCaller(authority, normal.projectId);
  assert.equal(retainedCaller?.revision, canonical.revision);
  assert.equal(providerWrites, 0);
  nativeEvents.push({
    type: "approval.settled",
    meta: { at: "2026-11-03T00:00:02Z", id: "original-caller-revoked" },
    data: {
      sequence: 3,
      stepIndex: 0,
      turnId: "turn",
      requestId: "original-caller-call",
      responderPrincipalId: authority.ownerUserId,
      outcome: "cancelled",
    },
  });
  const revokedOriginal = await deployment.request(revokedRevisionRequest);
  assert.equal(revokedOriginal.status, 403);
  const afterRevocation = await deployment.store.readReadyCaller(authority, normal.projectId);
  assert.equal(afterRevocation?.revision, canonical.revision);
  assert.equal(providerWrites, 0);
  authorized = false;
  const rejected = await deployment.request(request());
  assert.equal(rejected.status, 403);
  assert.equal(providerWrites, 0);
  console.log(
    "PASS central native composition: actual dispatcher/factory, restricted SQL, frozen source inspection, sealed runtime pointer/restart replay, separate-session unchanged caller reuse without new journal/approval, revoked original consent/current owner denial and zero provider writes",
  );
};
