import { createHash, generateKeyPairSync } from "node:crypto";
import { SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
import { hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import { resolveExportOwnerOrganization } from "./hosted-operator-export-customer";
import { verifyCapturedRealmIdentityProof } from "./hosted-operator-auth-identity";
import type { ExportOwnerOrganizationWitness } from "./hosted-operator-export-customer";

const keys = generateKeyPairSync("ed25519");
const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace",
  ownerUserId: "builder-owner",
};
const target = {
  appId: "review-app",
  sessionId: "saved-public-session",
  projectId: "app-project",
  branch: "preview",
  environment: "preview" as const,
  installationId: "owned-installation",
  scopeId: "team",
  scopeType: "team" as const,
};
const context = { authority, target };
const resource = {
  version: 1 as const,
  environment: "preview" as const,
  hostname: "ep-owned.neon.tech",
  database: "auth",
  migratorRole: "auth_owner",
  runtimeRole: "auth_runtime",
  port: 5432,
  schema: "public" as const,
  neon: { projectId: "neon-project", branchId: "neon-branch" },
};
const fixture = async () => {
  const issued = Math.floor(Date.now() / 1000) - 600;
  const capturedAt = new Date((issued + 1) * 1000).toISOString();
  const link = {
    audience: "https://operator.example",
    authResourceId: "auth-resource",
    bootstrapPlanDigest: "a".repeat(64),
    browserOrigin: "https://realm.example",
    endpointOrigin: "https://gateway.example",
    expiresAt: new Date((issued + 600) * 1000).toISOString(),
    issuer: "https://realm.example",
    nonceSha256: "b".repeat(64),
    organizationId: null,
    ownerSessionId: target.sessionId,
    consumedAt: capturedAt,
  };
  const claims = {
    aud: link.audience,
    authResourceId: link.authResourceId,
    bootstrapPlanDigest: link.bootstrapPlanDigest,
    exp: issued + 240,
    iat: issued,
    iss: link.issuer,
    nonceSha256: link.nonceSha256,
    organizationId: null,
    ownerSessionId: link.ownerSessionId,
    purpose: "realm-operator-link-v1" as const,
    resource,
    sessionId: "original-realm-session",
    sub: "original-realm-actor",
  };
  const proof = await new SignJWT(claims)
    .setProtectedHeader({
      alg: "EdDSA",
      kid: "trusted-key",
      typ: "platform-realm-operator-link+jwt",
    })
    .sign(keys.privateKey);
  const sha256 = createHash("sha256").update(proof).digest("hex");
  const identityProof = {
    reference: `_protected-operator/artifacts/realm-identity-proof/${target.appId}/${sha256}`,
    sha256,
  };
  const membership = {
    kind: "create-owned-organization",
    actorId: claims.sub,
    organizationId: "original-org",
    name: "Original organization",
    slug: "original-organization",
    bootstrapPlanDigest: link.bootstrapPlanDigest,
    identityNonceSha256: link.nonceSha256,
    identityProof,
    identityCapture: { capturedAt, realmSessionId: claims.sessionId },
    identityVerification: {
      issuer: link.issuer,
      audience: link.audience,
      jwksUrl: `${link.endpointOrigin}/_platform/jwks.json`,
      transportSource: {
        audience: "https://vercel.com",
        environment: "preview",
        issuer: "https://oidc.vercel.com/team",
        ownerId: "team",
        projectId: "operator-project",
      },
    },
  };
  const original = hostedOperatorPlanSchema.parse({
    action: "prepare",
    stage: "app",
    version: 1,
    contextId: "original-accepted-spec",
    access: [{ actorId: claims.sub, organizationId: "original-org", roles: ["reviewer"] }],
    authMembership: membership,
    appDatabase: {
      database: "app",
      migratorRole: "app_owner",
      runtimeRole: "app_runtime",
      resourceId: "app-resource",
    },
    authDatabase: {
      database: "auth",
      migratorRole: "auth_owner",
      runtimeRole: "auth_runtime",
      resourceId: "auth-resource",
    },
    cost: {
      class: "shared-recovery-group",
      description: "Approved prepared Preview",
      owner: authority.ownerUserId,
    },
    effects: [
      { id: "resources", kind: "resources", description: "Owned resources" },
      { id: "install", kind: "install", description: "Compiled release" },
      { id: "membership", kind: "auth-membership", description: "Original organization" },
      { id: "access", kind: "access", description: "Approved app access" },
      { id: "bindings", kind: "bindings", description: "Owned runtime" },
      { id: "gateway-bindings", kind: "gateway-bindings", description: "Owned Gateway" },
    ],
    installer: { reference: "worker", sha256: "c".repeat(64) },
    neon: {
      projectId: resource.neon.projectId,
      branchId: resource.neon.branchId,
      endpoint: resource.hostname,
      connectionRef: "owned-connection",
      source: "synthetic-only",
    },
    release: { id: "old-release", sha256: "d".repeat(64), artifactRef: "old-artifact" },
    retention: { expiresAt: "2027-01-01T00:00:00Z", policy: "Keep approved data" },
    selection: {
      appId: target.appId,
      sessionId: target.sessionId,
      projectId: target.projectId,
      branch: target.branch,
      environment: target.environment,
    },
    gatewayBindings: {
      authBrowserOrigin: link.browserOrigin,
      builderCallbackOrigin: "https://builder.example",
      catalogAppIds: [target.appId],
      operatorOrigin: "https://operator.example",
      sourceWorkload: {
        audience: "https://vercel.com",
        environment: "preview",
        issuer: "https://oidc.vercel.com/team",
        ownerId: "team",
        projectId: "app-project",
        subject: "app-preview",
      },
    },
    publicGateway: { branch: "preview", origin: link.browserOrigin, projectId: "gateway-project" },
    deploymentBoundary: {
      authority,
      teamId: "team",
      app: {
        branch: "preview",
        projectId: target.projectId,
        deploymentId: "app-deployment",
        environment: "preview",
      },
      gateway: {
        branch: "preview",
        projectId: "gateway-project",
        deploymentId: "gateway-deployment",
        environment: "preview",
      },
      operator: {
        projectId: "operator-project",
        deploymentId: "operator-deployment",
        environment: "preview",
      },
      verification: {
        publicOrigin: link.issuer,
        gatewayOrigin: link.endpointOrigin,
        jwksUrl: `${link.endpointOrigin}/_platform/jwks.json`,
      },
    },
  });
  const { authMembership: omitted, ...preparedInput } = {
    ...original,
    contextId: "newer-accepted-spec",
    appInstallation: { customerIds: ["original-org", "qa-org"] },
    access: [{ actorId: "qa-actor", organizationId: "qa-org", roles: ["reviewer"] }],
    release: {
      id: "different-current-release",
      sha256: "e".repeat(64),
      artifactRef: "current-artifact",
    },
    effects: original.effects.filter((effect) => effect.kind !== "auth-membership"),
  };
  void omitted;
  const prepared = hostedOperatorPlanSchema.parse(preparedInput);
  const historical = {
    approvedByCallId: "original-approved-call",
    operator: {
      mode: "protected-operator-v1" as const,
      operationRef: "00000000-0000-4000-8000-000000000001",
      approvalId: "original-approval",
      plan: original,
      planDigest: operatorPlanDigest(original),
      receipts: [],
      identityLink: { ...link, proofRef: identityProof.reference, proofSha256: sha256 },
    },
  };
  const record = hostedRuntimeJournalRecordSchema.parse({
    kind: "app-runtime",
    version: 1,
    status: "prepared",
    step: "bound",
    request: target,
    approvedByCallId: "current-call",
    operator: {
      mode: "protected-operator-v1",
      operationRef: "00000000-0000-4000-8000-000000000002",
      approvalId: "current-approval",
      plan: prepared,
      planDigest: operatorPlanDigest(prepared),
      receipts: [],
      retainedGatewayDeliveries: [historical],
    },
  });
  const assertCurrent = vi.fn(async () => {
    await Promise.resolve();
  });
  const readApproval = vi.fn(async () => await Promise.resolve(true));
  const getKey = vi.fn(async () => await Promise.resolve(keys.publicKey));
  const verifyProof = vi.fn(
    async (witness: ExportOwnerOrganizationWitness) =>
      await verifyCapturedRealmIdentityProof({ proof, pending: witness.link, resource, getKey }),
  );
  const readCurrentRecord = vi.fn(async () => await Promise.resolve(structuredClone(record)));
  return {
    input: { context, prepared, assertCurrent, readApproval, verifyProof, readCurrentRecord },
    record,
    historical,
    proof,
    getKey,
    claims,
  };
};

describe("original owner organization export selection", () => {
  it("selects the original installed tenant despite different current QA grants and schema", async () => {
    const f = await fixture();
    expect(await resolveExportOwnerOrganization(f.input)).toBe("original-org");
    expect(f.input.verifyProof).toHaveBeenCalledOnce();
    expect(f.input.readApproval).toHaveBeenCalledOnce();
  });
  it("accepts legacy optional app stage without requiring the current source digest", async () => {
    const f = await fixture();
    const historical = f.record.operator?.retainedGatewayDeliveries?.[0]?.operator;
    if (historical === undefined) {
      throw new Error("Missing historical operator");
    }
    delete historical.plan.stage;
    historical.planDigest = operatorPlanDigest(historical.plan);
    expect(await resolveExportOwnerOrganization(f.input)).toBe("original-org");
  });
  it("does not use a tampered signed historical proof", async () => {
    const f = await fixture();
    f.input.verifyProof.mockImplementationOnce(
      async (witness) =>
        await verifyCapturedRealmIdentityProof({
          proof: `${f.proof}tampered`,
          pending: witness.link,
          resource,
          getKey: f.getKey,
        }),
    );
    await expect(resolveExportOwnerOrganization(f.input)).rejects.toMatchObject({
      code: "export_customer_selection_required",
    });
  });
  it("deduplicates equivalent typed witnesses without a historical count gate", async () => {
    const f = await fixture();
    f.record.operator?.retainedGatewayDeliveries?.push(structuredClone(f.historical));
    expect(await resolveExportOwnerOrganization(f.input)).toBe("original-org");
    expect(f.input.verifyProof).toHaveBeenCalledOnce();
  });
  it("verifies one approved witness across distinct historical versions of the same organization", async () => {
    const f = await fixture();
    const later = structuredClone(f.historical);
    later.approvedByCallId = "later-approved-call";
    later.operator.operationRef = "00000000-0000-4000-8000-000000000003";
    later.operator.approvalId = "later-approval";
    f.record.operator?.retainedGatewayDeliveries?.push(later);
    expect(await resolveExportOwnerOrganization(f.input)).toBe("original-org");
    expect(f.input.readApproval).toHaveBeenCalledOnce();
    expect(f.input.verifyProof).toHaveBeenCalledOnce();
  });
  it.each(["approval", "proof"] as const)(
    "tries a later same-organization witness after an invalid first %s",
    async (invalid) => {
      const f = await fixture();
      const later = structuredClone(f.historical);
      later.approvedByCallId = "later-approved-call";
      later.operator.operationRef = "00000000-0000-4000-8000-000000000003";
      later.operator.approvalId = "later-approval";
      f.record.operator?.retainedGatewayDeliveries?.push(later);
      if (invalid === "approval") {
        f.input.readApproval.mockResolvedValueOnce(false);
      } else {
        f.input.verifyProof.mockRejectedValueOnce(new Error("Historical proof unavailable"));
      }
      expect(await resolveExportOwnerOrganization(f.input)).toBe("original-org");
      expect(f.input.readApproval).toHaveBeenCalledTimes(2);
      expect(f.input.verifyProof).toHaveBeenCalledTimes(invalid === "approval" ? 1 : 2);
    },
  );
  it.each(["ownerSessionId", "nonceSha256", "proofSha256", "authResourceId"] as const)(
    "ignores a foreign captured %s",
    async (field) => {
      const f = await fixture();
      const link = f.record.operator?.retainedGatewayDeliveries?.[0]?.operator.identityLink;
      if (link === undefined) {
        throw new Error("Missing witness");
      }
      link[field] = field.endsWith("Sha256") ? "f".repeat(64) : "foreign";
      await expect(resolveExportOwnerOrganization(f.input)).rejects.toMatchObject({
        code: "export_customer_selection_required",
      });
      expect(f.input.verifyProof).not.toHaveBeenCalled();
    },
  );
  it("rejects participant captures and noninstalled original tenants", async () => {
    const f = await fixture();
    const link = f.record.operator?.retainedGatewayDeliveries?.[0]?.operator.identityLink;
    if (link === undefined) {
      throw new Error("Missing witness");
    }
    link.browserSession = {
      operationRef: f.historical.operator.operationRef,
      participantProgramDigest: "f".repeat(64),
    };
    await expect(resolveExportOwnerOrganization(f.input)).rejects.toMatchObject({
      code: "export_customer_selection_required",
    });
    delete link.browserSession;
    f.input.prepared.appInstallation = { customerIds: ["qa-org"] };
    await expect(resolveExportOwnerOrganization(f.input)).rejects.toMatchObject({
      code: "export_customer_selection_required",
    });
  });
  it("requires each original approval and the cryptographically verified original actor", async () => {
    const f = await fixture();
    f.input.readApproval.mockResolvedValueOnce(false);
    await expect(resolveExportOwnerOrganization(f.input)).rejects.toMatchObject({
      code: "export_customer_selection_required",
    });
    f.input.verifyProof.mockResolvedValueOnce({ ...f.claims, sub: "qa-actor" });
    await expect(resolveExportOwnerOrganization(f.input)).rejects.toMatchObject({
      code: "export_customer_selection_required",
    });
  });
  it("preserves current owner revocation and changed historical witnesses", async () => {
    const f = await fixture();
    f.input.assertCurrent.mockRejectedValueOnce(new Error("owner revoked"));
    await expect(resolveExportOwnerOrganization(f.input)).rejects.toThrow("owner revoked");
    const verify = f.input.verifyProof.getMockImplementation();
    f.input.verifyProof.mockImplementationOnce(async (witness) => {
      if (verify === undefined) {
        throw new Error("Missing verifier");
      }
      const claims = await verify(witness);
      if (f.record.operator === undefined) {
        throw new Error("Missing operator");
      }
      f.record.operator.retainedGatewayDeliveries = [];
      return claims;
    });
    await expect(resolveExportOwnerOrganization(f.input)).rejects.toMatchObject({
      code: "reconciliation_required",
    });
  });
  it("clarifies rather than choosing among multiple authenticated original organizations", async () => {
    const f = await fixture();
    const second = structuredClone(f.historical);
    const plan = second.operator.plan;
    if (plan.authMembership?.kind !== "create-owned-organization") {
      throw new Error("Missing membership");
    }
    plan.authMembership.organizationId = "second-original-org";
    second.operator.operationRef = "00000000-0000-4000-8000-000000000003";
    second.operator.planDigest = operatorPlanDigest(plan);
    f.record.operator?.retainedGatewayDeliveries?.push(second);
    f.input.prepared.appInstallation?.customerIds.push("second-original-org");
    await expect(resolveExportOwnerOrganization(f.input)).rejects.toMatchObject({
      code: "export_customer_selection_required",
    });
  });
});
