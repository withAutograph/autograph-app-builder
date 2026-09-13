import { createLocalJWKSet, decodeJwt, exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, it } from "vitest";
import { createGitHubEvalAuthorizer } from "./github-eval-oidc";

const policy = {
  audience: "https://eval.example",
  ref: "refs/heads/main",
  repositoryId: "123",
  workflowRef: "owner/builder/.github/workflows/self-reproduction.yml@refs/heads/main",
};
const pair = await generateKeyPair("RS256");
const publicKey = await exportJWK(pair.publicKey);
const authorize = createGitHubEvalAuthorizer(policy, {
  keys: createLocalJWKSet({ keys: [publicKey] }),
});
const token = (overrides: Record<string, unknown> = {}) =>
  new SignJWT({
    base_ref: "",
    event_name: "workflow_dispatch",
    head_ref: "",
    ref: policy.ref,
    ref_type: "branch",
    repository_id: policy.repositoryId,
    run_attempt: "1",
    run_id: "456",
    workflow_ref: policy.workflowRef,
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer("https://token.actions.githubusercontent.com")
    .setAudience(policy.audience)
    .setIssuedAt()
    .setNotBefore("0s")
    .setExpirationTime("5m")
    .sign(pair.privateKey);

it("returns the signed run identity for the trusted dispatch", async () => {
  expect(await authorize(await token())).toEqual({
    ref: policy.ref,
    repositoryId: "123",
    runAttempt: "1",
    runId: "456",
    workflowRef: policy.workflowRef,
  });
});

it.each([
  { repository_id: "999" },
  { workflow_ref: "fork/builder/.github/workflows/self-reproduction.yml@refs/heads/main" },
  { ref: "refs/heads/other" },
  { event_name: "pull_request" },
  { head_ref: "fork" },
  { run_id: "" },
  { run_attempt: "0" },
  { ref_type: "tag" },
])("rejects unauthorized signed workflow claims %j", async (claims) => {
  await expect(authorize(await token(claims))).rejects.toThrow("could not be authorized");
});

it("rejects access to another persisted run or attempt", async () => {
  const signed = await token();
  await expect(authorize(signed, { runAttempt: "1", runId: "457" })).rejects.toThrow("authorized");
  await expect(authorize(signed, { runAttempt: "2", runId: "456" })).rejects.toThrow("authorized");
});

it.each(["issuer", "audience"])("rejects cryptographically signed wrong %s", async (field) => {
  const validClaims = decodeJwt(await token());
  const signed = await new SignJWT(validClaims)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(
      field === "issuer"
        ? "https://attacker.example"
        : "https://token.actions.githubusercontent.com",
    )
    .setAudience(field === "audience" ? "wrong" : policy.audience)
    .setIssuedAt()
    .setNotBefore("0s")
    .setExpirationTime("5m")
    .sign(pair.privateKey);
  await expect(authorize(signed)).rejects.toThrow("could not be authorized");
});

it("rejects a forged signature and expired token", async () => {
  const claims = decodeJwt(await token());
  const other = await generateKeyPair("RS256");
  const forged = await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .sign(other.privateKey);
  await expect(authorize(forged)).rejects.toThrow("could not be authorized");
  const expired = await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .setExpirationTime("-1s")
    .sign(pair.privateKey);
  await expect(authorize(expired)).rejects.toThrow("could not be authorized");
});
