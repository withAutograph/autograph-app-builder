import { expect, it } from "vitest";
import {
  candidateCapabilities,
  redactCandidateEvidence,
} from "./self-reproduction-candidate-capabilities";

it("passes only the supported project credential keys and makes no proof claim", () => {
  const result = candidateCapabilities({
    projectId: "project",
    teamId: "team",
    token: "sensitive",
  });
  expect(result.environment).toEqual({
    VERCEL_OIDC_TOKEN: "sensitive",
    VERCEL_PROJECT_ID: "project",
    VERCEL_TEAM_ID: "team",
  });
  expect(result.receipt.modelGateway).toBe("configured-unverified");
  expect(JSON.stringify(result.receipt)).not.toContain("sensitive");
  expect(candidateCapabilities().receipt.persistence).toContain("application-owned");
  expect(candidateCapabilities().environment).toEqual({});
});

it("redacts raw credentials in nested commands, startup and probe errors", () => {
  const secret = "plain-credential-without-a-key";
  const result = redactCandidateEvidence(
    {
      commands: [{ stderr: `error ${secret}`, stdout: secret }],
      probes: [{ detail: secret }],
      reason: secret,
    },
    [secret],
  );
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(result.reason).toBe("[REDACTED]");
});
