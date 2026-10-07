import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createOperatorWorkloadVerifier } from "./hosted-operator-workload";

const policy = {
  audience: "https://vercel.com/fixture-team",
  environment: "production" as const,
  issuer: "https://oidc.vercel.com/fixture-team",
  ownerId: "team_fixture",
  projectId: "prj_builder",
  subject: "owner:fixture-team:project:builder:environment:production",
};
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let verify: ReturnType<typeof createOperatorWorkloadVerifier>;
beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  const publicKey = { ...(await exportJWK(keys.publicKey)), alg: "RS256", kid: "fixture" };
  verify = createOperatorWorkloadVerifier(policy, createLocalJWKSet({ keys: [publicKey] }));
});
const token = async (
  claims: Record<string, string> = {},
  options: {
    issuer?: string;
    audience?: string;
    subject?: string;
    expired?: boolean;
    noExpiry?: boolean;
  } = {},
) => {
  const jwt = new SignJWT({
    environment: policy.environment,
    owner_id: policy.ownerId,
    project_id: policy.projectId,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(options.issuer ?? policy.issuer)
    .setAudience(options.audience ?? policy.audience)
    .setSubject(options.subject ?? policy.subject)
    .setIssuedAt();
  if (options.noExpiry !== true) {
    jwt.setExpirationTime(options.expired === true ? "-1m" : "1m");
  }
  return await jwt.sign(keys.privateKey);
};
const request = (value: string) =>
  new Request("https://operator.example.test/v1/runtime", {
    headers: { authorization: `Bearer ${value}` },
  });

describe("protected operator workload identity", () => {
  it("accepts only the configured signed workload", async () => {
    await expect(verify(request(await token()))).resolves.toBeUndefined();
  });
  it.each([
    ["issuer", { issuer: "https://oidc.vercel.com/another-team" }],
    ["audience", { audience: "https://vercel.com/another-team" }],
    ["subject", { subject: "owner:fixture-team:project:another-app:environment:production" }],
    ["expiry", { expired: true }],
    ["missing expiry", { noExpiry: true }],
  ])("rejects %s mismatch", async (_, options) => {
    await expect(verify(request(await token({}, options)))).rejects.toThrow(
      "authorization_required",
    );
  });
  it.each([{ owner_id: "team_other" }, { project_id: "prj_other" }, { environment: "preview" }])(
    "rejects changed provider workload claims %j",
    async (claims) => {
      await expect(verify(request(await token(claims)))).rejects.toThrow("authorization_required");
    },
  );
  it("rejects a forged signature and missing bearer", async () => {
    const other = await generateKeyPair("RS256");
    const forged = await new SignJWT({
      environment: policy.environment,
      owner_id: policy.ownerId,
      project_id: policy.projectId,
    })
      .setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .setIssuer(policy.issuer)
      .setAudience(policy.audience)
      .setSubject(policy.subject)
      .setIssuedAt()
      .setExpirationTime("1m")
      .sign(other.privateKey);
    await expect(verify(request(forged))).rejects.toThrow("authorization_required");
    await expect(verify(new Request("https://operator.example.test/v1/runtime"))).rejects.toThrow(
      "authorization_required",
    );
  });
});
