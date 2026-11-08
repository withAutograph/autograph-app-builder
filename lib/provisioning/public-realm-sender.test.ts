/* oxlint-disable eslint/require-await -- Private native verification port remains asynchronous. */
import { expect, it, vi } from "vitest";
import { createRealmIdentityHandoffSenderVerifier } from "./hosted-operator-realm-callback";
import { publicRealmEnrollmentSchema } from "./public-realm-enrollment";

const enrollment = publicRealmEnrollmentSchema.parse({
  version: 1,
  kind: "public-isolated-realm-v1",
  enrollmentRef: "11111111-1111-4111-a111-111111111111",
  appId: "invoice-app",
  ownerSessionId: "owner-session",
  authority: {
    issuer: "https://builder.example/api/auth",
    audience: "https://builder.example/mcp",
    ownerUserId: "owner",
    workspaceId: "workspace",
  },
  publicOrigin: "https://app.example",
  project: { projectId: "prj_app", ownerId: "team_owned", environment: "production" },
  sourceBootstrap: {
    operationRef: "22222222-2222-4222-a222-222222222222",
    planDigest: "b".repeat(64),
    authResourceId: "auth-owned",
  },
  resource: {
    version: 1,
    environment: "preview",
    hostname: "ep-isolated.neon.tech",
    port: 5432,
    database: "auth_owned",
    schema: "public",
    runtimeRole: "auth_runtime",
    migratorRole: "auth_migrator",
    neon: { projectId: "neon-owned", branchId: "br-owned" },
  },
});
const sender = {
  audience: "https://vercel.com/owned",
  environment: "production" as const,
  issuer: "https://oidc.vercel.com/owned",
  ownerId: "team_owned",
  projectId: "prj_app",
  publicEnrollment: enrollment,
  subject: "owner:owned:project:app:environment:production",
};
const payload = {
  iss: sender.issuer,
  aud: sender.audience,
  owner_id: sender.ownerId,
  project_id: sender.projectId,
  environment: sender.environment,
  sub: sender.subject,
};
const request = new Request("https://builder.example/api/hosted-operator/realm-identity", {
  headers: { authorization: "Bearer native.provider.token" },
  method: "POST",
});
it("verifies only the enrolled native Production sender without replacing its subject", async () => {
  const verify = vi.fn(async () => ({ payload }));
  await createRealmIdentityHandoffSenderVerifier(sender, verify)(request);
  expect(verify).toHaveBeenCalledWith(
    "native.provider.token",
    expect.objectContaining({
      environment: "production",
      projectId: "prj_app",
      subject: sender.subject,
    }),
  );
});
it.each(["owner_id", "project_id", "environment", "sub"] as const)(
  "rejects a verified foreign native %s",
  async (field) => {
    await expect(
      createRealmIdentityHandoffSenderVerifier(sender, async () => ({
        payload: { ...payload, [field]: "foreign" },
      }))(request),
    ).rejects.toThrow();
  },
);
it("rejects conflicting enrolled sender metadata before native verification", async () => {
  const verify = vi.fn(async () => ({ payload }));
  await expect(
    createRealmIdentityHandoffSenderVerifier({ ...sender, projectId: "foreign" }, verify)(request),
  ).rejects.toThrow();
  expect(verify).not.toHaveBeenCalled();
});
