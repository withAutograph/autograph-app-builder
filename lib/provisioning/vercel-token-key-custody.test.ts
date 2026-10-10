/* oxlint-disable eslint/require-await, typescript/unbound-method, unicorn/no-await-expression-member, unicorn/consistent-function-scoping, sonarjs/no-wildcard-import -- Asynchronous test doubles and direct assertions exercise explicit store/HTTP boundaries without real effects. */
import { z } from "zod";
import * as installationModule from "../integrations/postgres-vercel-installation";
import * as leaseModule from "./postgres-physical-resource-lease";
import * as secretModule from "./vercel-token-key-custody-secret";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  custodyActorDigest,
  custodyGrantDigest,
  custodyPlanDigest,
  custodyPlanSchema,
  custodyRecordSchema,
  createCustodySourceOperation,
  createCustodyPossessionProof,
  custodySlotLockKey,
  CustodyReconciliationRequiredError,
  CustodyUnavailableError,
} from "./vercel-token-key-custody";
import type {
  CustodyJournalRow,
  CustodyJournalStore,
  CustodyPhysicalLease,
  CustodyRecord,
} from "./vercel-token-key-custody";
import { createCustodySecretPort } from "./vercel-token-key-custody-secret";
import { custodyEnrollmentDigest, enrollCustodyGrant } from "./vercel-token-key-custody-enrollment";
import {
  createCustodyPossessionHandler,
  createCustodySourceHandler,
  readCustodyActiveKey,
} from "./vercel-token-key-custody-deployment";

const operationRef = "11111111-1111-4111-8111-111111111111";
const actor = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const fixture = () => {
  let clock = Date.parse("2026-10-10T12:00:00Z");
  const plan = custodyPlanSchema.parse({
    action: "transfer-active-vercel-token-key-to-operator-preview",
    actorAuthorityDigest: custodyActorDigest(actor),
    approvalExpiresAt: "2026-10-10T13:00:00Z",
    destination: {
      environment: "preview",
      gitBranch: null,
      key: "VERCEL_INTEGRATION_TOKEN_KEY",
      projectId: "operator",
      requiredVersion: "v1",
      teamId: "team",
      type: "sensitive",
      versionKey: "VERCEL_INTEGRATION_TOKEN_KEY_VERSION",
      write: "create-only",
    },
    installationId: "installation",
    operationRef,
    ownerSessionId: "session",
    source: {
      deploymentId: "source",
      environment: "production",
      key: "VERCEL_INTEGRATION_TOKEN_KEY",
      keyVersion: "v1",
      projectId: "builder",
      teamId: "team",
      versionKey: "VERCEL_INTEGRATION_TOKEN_KEY_VERSION",
    },
    version: 1,
  });
  const grant = {
    approvalRef: "approval",
    approvedAt: "2026-10-10T11:00:00Z",
    approvedPlanDigest: custodyPlanDigest(plan),
    expiresAt: plan.approvalExpiresAt,
    grantRef: "grant",
    operationRef,
    originalActor: actor,
    ownerSessionId: "session",
    scope: "source-global-active-v1-key-custody" as const,
    version: 1 as const,
  };
  let row: CustodyJournalRow = {
    record: custodyRecordSchema.parse({
      approvalRef: grant.approvalRef,
      fenceGeneration: 0,
      grantDigest: custodyGrantDigest(grant),
      grantRef: grant.grantRef,
      kind: "vercel-token-key-custody-v1",
      originalActor: actor,
      phase: "reserved",
      plan,
      planDigest: custodyPlanDigest(plan),
      setupGrant: grant,
      version: 1,
    }),
    revision: 1,
  };
  const store: CustodyJournalStore = {
    compareAndSet: vi.fn(async (input: Parameters<CustodyJournalStore["compareAndSet"]>[0]) => {
      if (input.expectedRevision !== row.revision) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- The CAS mock explicitly returns absent on contention.
        return undefined;
      }
      row = { record: custodyRecordSchema.parse(input.record), revision: row.revision + 1 };
      return structuredClone(row);
    }),
    findSlotClaims: async () => [structuredClone(row)],
    read: async () => structuredClone(row),
    reserve: vi.fn(async (input: Parameters<CustodyJournalStore["reserve"]>[0]) => {
      row = { record: input.record, revision: 1 };
      return structuredClone(row);
    }),
  };
  const lease: CustodyPhysicalLease = async (input, run) => {
    await input.initializeUnderLock?.();
    const snapshot = await input.readCurrentFence();
    return await run(async () => {
      expect(await input.readCurrentFence()).toEqual(snapshot);
    });
  };
  const secret = {
    gitBranch: null,
    id: "secret-row",
    key: "VERCEL_INTEGRATION_TOKEN_KEY" as const,
    projectId: "operator",
    target: ["preview"] satisfies ["preview"],
    teamId: "team",
    type: "sensitive" as const,
  };
  let keyPresent = false;
  let revoked = false;
  const secretPort = {
    create: vi.fn(async (key: Buffer, assertFence: () => Promise<void>) => {
      expect(row.record.phase).toBe("attempted");
      expect(row.record.attemptedAt).toBeDefined();
      await assertFence();
      expect(key).toEqual(Buffer.alloc(32, 7));
      keyPresent = true;
      return secret;
    }),
    inspect: vi.fn(async () => (keyPresent ? secret : undefined)),
    observeReceiver: vi.fn(
      async (): Promise<{ deploymentId: string; origin: string } | undefined> => ({
        deploymentId: "receiver",
        origin: "https://receiver.example",
      }),
    ),
  };
  const currentSetup = async () => {
    if (revoked) {
      throw new CustodyUnavailableError();
    }
    return { actor, grant, plan };
  };
  const requestPossession = vi.fn(async () =>
    createCustodyPossessionProof(row.record, Buffer.alloc(32, 7)),
  );
  const run = createCustodySourceOperation({
    currentSetup,
    now: () => clock,
    physicalLease: lease,
    readActiveKey: async () => Buffer.alloc(32, 7),
    requestPossession,
    secret: secretPort,
    store,
  });
  return {
    advance: () => {
      clock += 121_000;
    },
    currentSetup,
    edit: (fn: (record: CustodyRecord) => void) => {
      fn(row.record);
    },
    grant,
    keyPresent: () => {
      keyPresent = true;
    },
    lease,
    now: () => clock,
    plan,
    requestPossession,
    revoke: () => {
      revoked = true;
    },
    row: () => structuredClone(row),
    run,
    secretPort,
    store,
  };
};
afterEach(() => vi.restoreAllMocks());

describe("closed custody state machine", () => {
  it("persists attempted before one Secret write, verifies HMAC, consumes once and reconciles duplicate delivery", async () => {
    const f = fixture();
    const receipt = await f.run(operationRef);
    expect(receipt).toMatchObject({
      possession: "verified",
      providerRowId: "secret-row",
      receivingDeploymentId: "receiver",
    });
    expect(f.row().record.phase).toBe("possession-verified");
    expect(f.row().record.nonceConsumedAt).toBeDefined();
    expect(await f.run(operationRef)).toEqual(receipt);
    expect(f.secretPort.create).toHaveBeenCalledTimes(1);
    expect(f.requestPossession).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.row())).not.toContain(Buffer.alloc(32, 7).toString("base64"));
    expect(f.store.reserve).not.toHaveBeenCalled();
  });
  it("retains unknown attempted state after timeout and never retries even with one absent read", async () => {
    const f = fixture();
    f.secretPort.create.mockRejectedValueOnce(new CustodyReconciliationRequiredError());
    await expect(f.run(operationRef)).rejects.toThrow("reconciliation");
    expect(f.row().record.phase).toBe("attempted");
    f.advance();
    await expect(f.run(operationRef)).rejects.toThrow("reconciliation");
    expect(f.secretPort.create).toHaveBeenCalledTimes(1);
  });
  it("reconciles a delayed accepted POST through its saved owned metadata without repeating the write", async () => {
    const f = fixture();
    f.secretPort.create.mockImplementationOnce(async () => {
      f.keyPresent();
      throw new CustodyReconciliationRequiredError();
    });
    await expect(f.run(operationRef)).rejects.toThrow("reconciliation");
    f.advance();
    expect(await f.run(operationRef)).toMatchObject({ possession: "verified" });
    expect(f.secretPort.create).toHaveBeenCalledTimes(1);
  });
  it("fails after revocation and rejects possession byte mismatch", async () => {
    const f = fixture();
    f.requestPossession.mockResolvedValueOnce("a".repeat(64));
    await expect(f.run(operationRef)).rejects.toThrow("unavailable");
    expect(f.row().record.phase).toBe("possession-pending");
    expect(f.row().record.nonceConsumedAt).toBeUndefined();
    f.revoke();
    await expect(f.run(operationRef)).rejects.toThrow("unavailable");
  });
  it("binds receipt, Secret scope, grant and phase; slot identity ignores owner/session/operation", async () => {
    const f = fixture();
    await f.run(operationRef);
    const verified = f.row().record;
    expect(
      custodyRecordSchema.safeParse({
        ...verified,
        receipt: { ...verified.receipt, providerRowId: "foreign" },
      }).success,
    ).toBe(false);
    expect(
      custodyRecordSchema.safeParse({
        ...verified,
        secret: { ...verified.secret, teamId: "foreign" },
      }).success,
    ).toBe(false);
    expect(custodyRecordSchema.safeParse({ ...verified, phase: "reserved" }).success).toBe(false);
    expect(
      custodyRecordSchema.safeParse({
        ...verified,
        setupGrant: { ...verified.setupGrant, approvalRef: "foreign" },
      }).success,
    ).toBe(false);
    expect(
      custodySlotLockKey({
        ...f.plan,
        operationRef: "22222222-2222-4222-8222-222222222222",
        ownerSessionId: "another",
      }),
    ).toBe(custodySlotLockKey(f.plan));
  });
  it("wipes active key even when the attempted checkpoint CAS fails", async () => {
    const f = fixture();
    const key = Buffer.alloc(32, 7);
    const original = f.store.compareAndSet;
    f.store.compareAndSet = async (input) =>
      input.record.phase === "attempted" ? undefined : await original(input);
    const run = createCustodySourceOperation({
      currentSetup: f.currentSetup,
      now: f.now,
      physicalLease: f.lease,
      readActiveKey: async () => key,
      requestPossession: f.requestPossession,
      secret: f.secretPort,
      store: f.store,
    });
    await expect(run(operationRef)).rejects.toThrow("unavailable");
    expect(key).toEqual(Buffer.alloc(32));
    expect(f.secretPort.create).not.toHaveBeenCalled();
  });
});

describe("private enrollment and HTTP boundary", () => {
  it("reserves only the reviewed digest under the physical lock with current original owner", async () => {
    const f = fixture();
    const request = {
      action: "enroll-active-v1-key-custody" as const,
      record: f.row().record,
      version: 1 as const,
    };
    const owner = vi.fn(async () => {});
    await expect(
      enrollCustodyGrant({
        assertOriginalOwner: owner,
        confirmationDigest: "a".repeat(64),
        now: f.now,
        physicalLease: f.lease,
        request,
        store: f.store,
      }),
    ).rejects.toThrow("unavailable");
    expect(f.store.reserve).not.toHaveBeenCalled();
    expect(
      await enrollCustodyGrant({
        assertOriginalOwner: owner,
        confirmationDigest: custodyEnrollmentDigest(request),
        now: f.now,
        physicalLease: f.lease,
        request,
        store: f.store,
      }),
    ).toMatchObject({ enrolled: true, grantRef: "grant" });
    expect(owner).toHaveBeenCalled();
  });
  it("leaves both private routes unavailable without enrollment/configuration", async () => {
    const request = new Request("https://builder.example", {
      body: JSON.stringify({ operationRef }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect((await createCustodySourceHandler({})(request.clone())).status).toBe(503);
    expect((await createCustodyPossessionHandler({})(request.clone())).status).toBe(503);
  });
  it("composes the actual Source handler from the narrow saved grant and original installation without full runtime setup", async () => {
    const f = fixture();
    vi.spyOn(Date, "now").mockImplementation(f.now);
    const sourceWorkload = {
      audience: "https://vercel.com/team",
      environment: "production" as const,
      issuer: "https://oidc.vercel.com/team",
      ownerId: "team",
      projectId: "builder",
      subject: "source-subject",
    };
    const setup = {
      capturedOwner: {
        adapterGeneration: 1,
        adapterSessionId: "adapter",
        authority: actor,
        kind: "direct" as const,
        principal: { ...actor, scopes: ["autograph:get"] },
        sessionId: "session",
      },
      grantRef: "grant",
      operationRef,
      recipient: {
        origin: "https://operator.example",
        workload: {
          ...sourceWorkload,
          environment: "preview" as const,
          projectId: "operator",
          subject: "recipient-subject",
        },
      },
      source: { origin: "https://builder.example", workload: sourceWorkload },
      version: 1 as const,
    };
    const tokenReader = vi
      .spyOn(installationModule, "readActiveVercelInstallationToken")
      .mockResolvedValue({
        binding: {
          active: true,
          displayName: "fixture",
          installationId: "installation",
          plan: "fixture",
          scopeId: "team",
          scopeType: "team",
          slug: "fixture",
          updatedAt: new Date(f.now()),
        },
        token: "fixture-token",
      });
    vi.spyOn(leaseModule, "createPostgresPhysicalResourceLease").mockReturnValue(f.lease);
    vi.spyOn(secretModule, "createCustodySecretPort").mockImplementation((input) => ({
      ...f.secretPort,
      create: async (key, assertFence) => {
        await input.readInstallationToken();
        return await f.secretPort.create(key, assertFence);
      },
    }));
    // No receiver yet: the actual handler must finish the key checkpoint and return metadata.
    // oxlint-disable-next-line unicorn/no-useless-undefined -- The receiver mock represents the absence of a refreshed deployment.
    f.secretPort.observeReceiver.mockResolvedValueOnce(undefined);
    const environment = {
      DATABASE_URL: "postgresql://fixture:fixture@fixture-pooler.neon.tech/db?sslmode=require",
      VERCEL_INTEGRATION_TOKEN_KEY: Buffer.alloc(32, 7).toString("base64"),
      VERCEL_INTEGRATION_TOKEN_KEY_VERSION: "v1",
    };
    const local = vi.fn(async () => {});
    const owner = vi.fn(async () => {});
    const handler = createCustodySourceHandler(environment, {
      assertLocal: local,
      currentOwner: owner,
      readSetup: async () => setup,
      store: f.store,
      verifyCaller: async () => {},
    });
    const request = new Request("https://builder.example/api/hosted-operator/key-custody", {
      body: JSON.stringify({ operationRef }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const response = await handler(request.clone());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ operationRef, phase: "secret-confirmed" });
    expect(tokenReader).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: actor,
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- Vitest matcher intentionally checks only the narrow keyring version.
        config: expect.objectContaining({ tokenKeyVersion: "v1" }),
        installationId: "installation",
      }),
    );
    expect(local).toHaveBeenCalledWith(environment, setup, "source", "source");
    expect(owner).toHaveBeenCalled();
    owner.mockRejectedValueOnce(new CustodyUnavailableError());
    expect((await handler(request.clone())).status).toBe(503);
    expect(tokenReader).toHaveBeenCalledTimes(1);
  });
  it("accepts only a saved pending selector and rechecks checkpoint before returning the possession proof", async () => {
    const f = fixture();
    vi.spyOn(Date, "now").mockImplementation(f.now);
    const sourceWorkload = {
      audience: "https://vercel.com/team",
      environment: "production" as const,
      issuer: "https://oidc.vercel.com/team",
      ownerId: "team",
      projectId: "builder",
      subject: "source-subject",
    };
    const setup = {
      capturedOwner: {
        adapterGeneration: 1,
        adapterSessionId: "adapter",
        authority: actor,
        kind: "direct" as const,
        principal: { ...actor, scopes: ["autograph:get"] },
        sessionId: "session",
      },
      grantRef: "grant",
      operationRef,
      recipient: {
        origin: "https://operator.example",
        workload: {
          ...sourceWorkload,
          environment: "preview" as const,
          projectId: "operator",
          subject: "recipient-subject",
        },
      },
      source: { origin: "https://builder.example", workload: sourceWorkload },
      version: 1 as const,
    };
    const local = vi.fn(async () => {});
    const owner = vi.fn(async () => {});
    const handler = createCustodyPossessionHandler(
      {
        DATABASE_URL: "postgresql://fixture:fixture@fixture-pooler.neon.tech/db?sslmode=require",
        VERCEL_INTEGRATION_TOKEN_KEY: Buffer.alloc(32, 7).toString("base64"),
        VERCEL_INTEGRATION_TOKEN_KEY_VERSION: "v1",
      },
      {
        assertLocal: local,
        currentOwner: owner,
        readSetup: async () => setup,
        store: f.store,
        verifyCaller: async () => {},
      },
    );
    const request = (body: { operationRef: string; nonce?: string }) =>
      new Request("https://receiver.example/v1/key-custody/possession", {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    expect((await handler(request({ nonce: "caller-selected", operationRef }))).status).toBe(503);
    expect(owner).not.toHaveBeenCalled();
    f.requestPossession.mockImplementationOnce(async () => {
      const response = await handler(request({ operationRef }));
      expect(response.status).toBe(200);
      expect(local).toHaveBeenCalledWith(expect.anything(), setup, "recipient", "receiver");
      return z.object({ proof: z.string() }).parse(await response.json()).proof;
    });
    expect(await f.run(operationRef)).toMatchObject({ possession: "verified" });
    expect((await handler(request({ operationRef }))).status).toBe(503);
    expect(owner.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
  it("never reads previous keys and requires active v1", () => {
    const environment = {
      VERCEL_INTEGRATION_TOKEN_KEY: Buffer.alloc(32, 7).toString("base64"),
      VERCEL_INTEGRATION_TOKEN_KEY_VERSION: "v1",
      // oxlint-disable-next-line sonarjs/function-name -- This getter matches the exact environment key and fails if read.
      get VERCEL_INTEGRATION_TOKEN_PREVIOUS_KEYS(): string {
        throw new Error("previous keys accessed");
      },
    };
    expect(readCustodyActiveKey(environment)).toEqual(Buffer.alloc(32, 7));
    expect(() =>
      readCustodyActiveKey({
        VERCEL_INTEGRATION_TOKEN_KEY: environment.VERCEL_INTEGRATION_TOKEN_KEY,
        VERCEL_INTEGRATION_TOKEN_KEY_VERSION: "v2",
      }),
    ).toThrow();
  });
});

describe("fixed Vercel Secret wire port", () => {
  const portFixture = () => {
    const f = fixture();
    let present = false;
    let visibility = "secret";
    const calls: { url: URL; init?: RequestInit }[] = [];
    const comment = `autograph:key-custody:v1:${operationRef}:${custodyPlanDigest(f.plan)}:${custodyGrantDigest(f.grant)}`;
    const row = () => ({
      comment,
      gitBranch: null,
      id: "row",
      key: "VERCEL_INTEGRATION_TOKEN_KEY",
      target: "preview",
      type: "encrypted",
      visibility,
    });
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = new URL(url instanceof Request ? url.url : url);
      calls.push({ init, url: target });
      if (init?.method === "POST") {
        present = true;
        return Response.json({ created: row(), failed: [] });
      }
      if (target.pathname.includes("/aliases/")) {
        return Response.json({
          alias: "operator.example",
          deploymentId: "receiver",
          projectId: "operator",
        });
      }
      if (target.pathname.includes("/deployments/")) {
        return Response.json({
          createdAt: f.now() + 1,
          id: "receiver",
          ownerId: "team",
          projectId: "operator",
          readyState: "READY",
          target: null,
          url: "receiver.example",
        });
      }
      if (target.pathname.endsWith("/env/version")) {
        return Response.json({
          id: "version",
          key: "VERCEL_INTEGRATION_TOKEN_KEY_VERSION",
          target: ["preview"],
          type: "encrypted",
          value: "v1",
          visibility: "config",
        });
      }
      if (target.pathname.endsWith("/env")) {
        return Response.json({
          envs: [
            { key: "UNRELATED", target: "custom" },
            {
              id: "version",
              key: "VERCEL_INTEGRATION_TOKEN_KEY_VERSION",
              target: ["preview"],
              type: "encrypted",
              value: "ciphertext",
              visibility: "config",
            },
            ...(present ? [row()] : []),
          ],
        });
      }
      return Response.json({ accountId: "team", id: "operator" });
    });
    const port = createCustodySecretPort({
      fetch: fetcher,
      grantDigest: custodyGrantDigest(f.grant),
      plan: f.plan,
      planDigest: custodyPlanDigest(f.plan),
      readInstallationToken: async () => "fixture-installation-token",
      recipientOrigin: "https://operator.example",
    });
    return {
      calls,
      downgrade: () => {
        visibility = "config";
      },
      f,
      fetcher,
      port,
    };
  };
  it("uses sensitive create-only, reads only VERSION Config plaintext, ignores unrelated layout and observes immutable receiver", async () => {
    const f = portFixture();
    expect(await f.port.inspect()).toBeUndefined();
    const fence = vi.fn(async () => {});
    const metadata = await f.port.create(Buffer.alloc(32, 7), fence);
    expect(metadata.type).toBe("sensitive");
    expect(await f.port.inspect(metadata)).toEqual(metadata);
    const post = f.calls.find((call) => call.init?.method === "POST");
    if (post === undefined) {
      throw new Error("Missing expected create request.");
    }
    expect(post.url.searchParams.get("upsert")).toBe("false");
    expect(post.url.searchParams.get("teamId")).toBe("team");
    expect(JSON.parse(z.string().parse(post.init?.body))).toMatchObject({
      gitBranch: null,
      key: "VERCEL_INTEGRATION_TOKEN_KEY",
      target: ["preview"],
      type: "sensitive",
    });
    expect(f.calls.filter((call) => call.url.pathname.endsWith("/env/row"))).toHaveLength(0);
    expect(f.calls.filter((call) => call.url.searchParams.has("decrypt"))).toHaveLength(0);
    expect(await f.port.observeReceiver(new Date(f.f.now()).toISOString())).toEqual({
      deploymentId: "receiver",
      origin: "https://receiver.example",
    });
    f.downgrade();
    await expect(f.port.inspect(metadata)).rejects.toThrow("reconciliation");
  });
  it("treats HTTP 200 partial failures and reflected provider body as unknown safe outcomes", async () => {
    const f = portFixture();
    f.fetcher.mockResolvedValueOnce(
      Response.json({ created: [], failed: [{ value: "secret-reflected" }] }),
    );
    await expect(f.port.create(Buffer.alloc(32, 7), async () => {})).rejects.toThrow(
      "requires reconciliation",
    );
  });
});
