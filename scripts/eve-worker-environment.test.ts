import { randomBytes, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  captureEveWorkerEnvelope,
  installEveWorkerEnvelope,
} from "./eve-worker-environment.mjs";

const appRoot = "/owned/app";

function trustedSource(overrides: Record<string, string | undefined> = {}) {
  return {
    EVE_DEV: "1",
    EVE_DEV_WORKER_APP_ROOT: appRoot,
    WORKFLOW_LOCAL_BASE_URL: "http://127.0.0.1:43123",
    PORT: "43123",
    EVE_DEV_WORKFLOW_TRANSPORT_SECRET: randomBytes(32).toString("base64url"),
    EVE_DEVELOPMENT_SANDBOX_RUN_ID: randomUUID(),
    EVE_EVALUATION: "1",
    EVE_EVALUATION_RUN_ID: randomUUID(),
    ...overrides,
  };
}

describe("closed Eve worker environment", () => {
  it("captures and reinstalls one exact nested worker envelope", () => {
    const first = captureEveWorkerEnvelope(trustedSource(), appRoot);
    const environment: Record<string, string | undefined> = {};
    installEveWorkerEnvelope(environment, first, appRoot);
    const nested = captureEveWorkerEnvelope(environment, appRoot);

    expect(environment).toMatchObject({
      EVE_DEV: "1",
      EVE_DEV_WORKER_APP_ROOT: appRoot,
      WORKFLOW_LOCAL_BASE_URL: "http://127.0.0.1:43123",
      PORT: "43123",
      EVE_EVALUATION: "1",
    });
    expect(nested.baseUrl).toBe(first.baseUrl);
    expect(nested.port).toBe(first.port);
    expect(nested.evaluationRunId).toBe(first.evaluationRunId);
    expect(nested.developmentSandboxRunId).toBe(first.developmentSandboxRunId);
    expect(nested.transportSecret).toHaveLength(43);
  });

  it.each([
    ["non-loopback", { WORKFLOW_LOCAL_BASE_URL: "http://192.0.2.1:43123" }],
    ["credential", { WORKFLOW_LOCAL_BASE_URL: "http://user@127.0.0.1:43123" }],
    ["path", { WORKFLOW_LOCAL_BASE_URL: "http://127.0.0.1:43123/path" }],
    ["query", { WORKFLOW_LOCAL_BASE_URL: "http://127.0.0.1:43123?x=1" }],
    ["missing port", { WORKFLOW_LOCAL_BASE_URL: "http://127.0.0.1" }],
    ["port mismatch", { PORT: "43124" }],
    ["development marker", { EVE_DEV: "0" }],
    ["evaluation marker", { EVE_EVALUATION: "0" }],
    ["evaluation id", { EVE_EVALUATION_RUN_ID: "not-a-uuid" }],
    ["sandbox id", { EVE_DEVELOPMENT_SANDBOX_RUN_ID: "not-a-uuid" }],
  ])("rejects %s drift", (_name, overrides) => {
    expect(() =>
      captureEveWorkerEnvelope(trustedSource(overrides), appRoot),
    ).toThrow(/trusted Eve worker/u);
  });

  it("rejects malformed transport secrets without disclosing them", () => {
    const hostileSecret = "do-not-disclose-this-hostile-secret";
    let message = "";
    try {
      captureEveWorkerEnvelope(
        trustedSource({ EVE_DEV_WORKFLOW_TRANSPORT_SECRET: hostileSecret }),
        appRoot,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe(
      "The trusted Eve worker transport secret was invalid.",
    );
    expect(message).not.toContain(hostileSecret);
  });

  it("accepts an absent optional sandbox run id", () => {
    const envelope = captureEveWorkerEnvelope(
      trustedSource({ EVE_DEVELOPMENT_SANDBOX_RUN_ID: undefined }),
      appRoot,
    );
    const environment: Record<string, string | undefined> = {
      EVE_DEVELOPMENT_SANDBOX_RUN_ID: "hostile",
    };
    installEveWorkerEnvelope(environment, envelope, appRoot);
    expect(environment.EVE_DEVELOPMENT_SANDBOX_RUN_ID).toBeUndefined();
  });
});
