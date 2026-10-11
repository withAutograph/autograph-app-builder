import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { verifyVercelOidcToken } from "@vercel/oidc";
import { createOperatorWorkloadVerifier } from "./hosted-operator-workload";
import type { OperatorWorkloadPolicy } from "./hosted-operator-workload";
import {
  assertLocalDeployment,
  custodySetupConfigurationSchema,
  createCustodySourceHandler,
} from "./vercel-token-key-custody-deployment";

const policy = {
  audience: "https://vercel.com/team_fixture",
  environment: "production" as const,
  issuer: "https://oidc.vercel.com/team_fixture",
  ownerId: "team_fixture",
  projectId: "prj_builder",
  subject: "owner:team_fixture:project:builder:environment:production",
};
const owner = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const config = custodySetupConfigurationSchema.parse({
  capturedOwner: {
    adapterGeneration: 1,
    adapterSessionId: "adapter-session",
    authority: owner,
    kind: "direct",
    principal: { ...owner, scopes: ["autograph:get"] },
    sessionId: "session",
  },
  grantRef: "grant",
  operationRef: "11111111-1111-4111-8111-111111111111",
  recipient: {
    origin: "https://operator.example",
    workload: {
      ...policy,
      environment: "preview" as const,
      projectId: "prj_operator",
      subject: "owner:team_fixture:project:operator:environment:preview",
    },
  },
  source: { origin: "https://builder.example", workload: policy },
  version: 1,
});
const deploymentId = "dpl_source_fixture";
const expectedVerification = {
  environment: policy.environment,
  ownerId: policy.ownerId,
  projectId: policy.projectId,
};
const environment = {
  VERCEL_DEPLOYMENT_ID: deploymentId,
  VERCEL_PROJECT_ID: policy.projectId,
  VERCEL_TARGET_ENV: "production",
};

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let localKeySet: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  const publicKey = {
    ...(await exportJWK(keys.publicKey)),
    alg: "RS256",
    kid: "custody-workload-fixture",
  };
  localKeySet = createLocalJWKSet({ keys: [publicKey] });
});

afterEach(() => vi.restoreAllMocks());

const signToken = async (
  claims: Partial<Record<"owner_id" | "project_id" | "environment", string>> = {},
) => {
  const token = await new SignJWT({
    environment: policy.environment,
    owner_id: policy.ownerId,
    project_id: policy.projectId,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "custody-workload-fixture" })
    .setIssuer(policy.issuer)
    .setAudience(policy.audience)
    .setSubject(policy.subject)
    .setIssuedAt()
    .setExpirationTime("1m")
    .sign(keys.privateKey);
  return token;
};

const localVerifierDependencies = (token: string) => ({
  createWorkloadVerifier: (input: OperatorWorkloadPolicy) =>
    createOperatorWorkloadVerifier(input, localKeySet),
  getToken: async () => {
    await Promise.resolve();
    return token;
  },
  verifyToken: async (
    receivedToken: string,
    options: Parameters<typeof verifyVercelOidcToken>[1],
  ) => {
    expect(receivedToken).toBe(token);
    expect(options).toEqual(expectedVerification);
    await createOperatorWorkloadVerifier(
      policy,
      localKeySet,
    )(
      new Request("https://builder.example", {
        headers: { authorization: `Bearer ${receivedToken}` },
      }),
    );
  },
});

describe("local custody deployment identity", () => {
  it("accepts exact deployment and project claims without VERCEL_ORG_ID", async () => {
    const token = await signToken();

    await expect(
      assertLocalDeployment(
        environment,
        config,
        "source",
        deploymentId,
        localVerifierDependencies(token),
      ),
    ).resolves.toBeUndefined();
  });

  it("accepts the documented VERCEL_ENV fallback when target env is absent", async () => {
    const token = await signToken();

    await expect(
      assertLocalDeployment(
        {
          VERCEL_DEPLOYMENT_ID: deploymentId,
          VERCEL_ENV: "production",
          VERCEL_PROJECT_ID: policy.projectId,
        },
        config,
        "source",
        deploymentId,
        localVerifierDependencies(token),
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["deployment ID", { ...environment, VERCEL_DEPLOYMENT_ID: "dpl_other" }, deploymentId],
    ["project ID", { ...environment, VERCEL_PROJECT_ID: "prj_other" }, deploymentId],
    ["target environment", { ...environment, VERCEL_TARGET_ENV: "preview" }, deploymentId],
    [
      "environment fallback",
      {
        VERCEL_DEPLOYMENT_ID: deploymentId,
        VERCEL_ENV: "preview",
        VERCEL_PROJECT_ID: policy.projectId,
      },
      deploymentId,
    ],
    ["expected deployment", environment, "dpl_other"],
  ])("rejects a mismatched local %s before token verification", async (_, current, expected) => {
    const calls: string[] = [];
    await expect(
      assertLocalDeployment(current, config, "source", expected, {
        createWorkloadVerifier: () => {
          calls.push("policy");
          return async () => {
            await Promise.resolve();
          };
        },
        getToken: async () => {
          await Promise.resolve();
          calls.push("token");
          return "token-canary";
        },
        verifyToken: async () => {
          await Promise.resolve();
          calls.push("verify");
        },
      }),
    ).rejects.toThrow("unavailable");

    expect(calls).toEqual([]);
  });

  it("denies a correctly signed token whose owner claim differs from the policy", async () => {
    const token = await signToken({ owner_id: "team_other" });

    await expect(
      assertLocalDeployment(
        environment,
        config,
        "source",
        deploymentId,
        localVerifierDependencies(token),
      ),
    ).rejects.toThrow("authorization_required");
  });

  it("denies failure from the separate policy workload verifier", async () => {
    const token = await signToken();

    await expect(
      assertLocalDeployment(environment, config, "source", deploymentId, {
        ...localVerifierDependencies(token),
        createWorkloadVerifier: () => async () => {
          await Promise.resolve();
          throw new Error("policy workload denied");
        },
      }),
    ).rejects.toThrow("policy workload denied");
  });

  it("logs only a fixed failure stage while keeping the response generic", async () => {
    const failureLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = createCustodySourceHandler(
      {},
      {
        readSetup: async () => {
          await Promise.resolve();
          return config;
        },
        verifyCaller: async () => {
          await Promise.resolve();
          throw new Error("private-owner-token-canary");
        },
      },
    );
    const response = await handler(
      new Request("https://builder.example/api/hosted-operator/key-custody", {
        body: JSON.stringify({ operationRef: config.operationRef }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "key_custody_unavailable" });
    expect(failureLog.mock.calls).toEqual([
      ["Custody source request failed.", { stage: "caller_workload" }],
    ]);
    expect(JSON.stringify(failureLog.mock.calls)).not.toContain("private-owner-token-canary");
  });
});
