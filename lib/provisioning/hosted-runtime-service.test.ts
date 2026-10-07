/* oxlint-disable eslint/require-await, sonarjs/publicly-writable-directories, sonarjs/no-hardcoded-passwords -- In-memory fixtures never access these paths and use only synthetic credentials. */
import { z } from "zod";

import { describe, expect, it, vi } from "vitest";

import { encryptVercelToken } from "../integrations/vercel-installation";
import type { VercelIntegrationConfig } from "../integrations/vercel-installation";
import type {
  HostedRuntimeJournalRecord,
  HostedRuntimeJournalRow,
  HostedRuntimeJournalStore,
  HostedRuntimeTarget,
} from "./hosted-runtime-journal";
import { hostedRuntimeIdentity } from "./hosted-runtime-journal";
import {
  decryptHostedRuntimeFiles,
  HostedRuntimeCommandError,
  hostedRuntimeBindings,
  hostedRuntimeExecutionEnvironment,
  encryptHostedRuntimeFiles,
  prepareHostedRuntime,
} from "./hosted-runtime-service";
import type { HostedRuntimeExecutor, PrivateRuntimeFiles } from "./hosted-runtime-service";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner_1",
  workspaceId: "workspace_1",
};
const target: HostedRuntimeTarget = {
  appId: "spend-review",
  branch: "builder/spend-review",
  environment: "preview",
  installationId: "icfg_builder",
  projectId: "prj_services",
  scopeId: "team_owner",
  scopeType: "team",
  sessionId: "session_1",
};
const config: VercelIntegrationConfig = {
  clientId: "client",
  clientSecret: "fixture-secret",
  issuer: authority.issuer,
  resource: authority.audience,
  slug: "builder",
  tokenKey: Buffer.alloc(32, 9),
  tokenKeyVersion: "fixture_v1",
};
const credential = {
  binding: {
    active: true,
    displayName: "Owner",
    installationId: target.installationId,
    plan: "pro",
    scopeId: target.scopeId,
    scopeType: target.scopeType,
    slug: "owner",
    updatedAt: new Date(),
  },
  token: "fixture-token",
};
const clusterUrl =
  "postgresql://installer:fixture-admin-secret@ep-owner.us-east-1.aws.neon.tech/neondb?sslmode=verify-full";
const native = {
  comment: "Native integration",
  configurationId: "icfg_neon",
  gitBranch: target.branch,
  id: "env_native",
  key: "DATABASE_URL_UNPOOLED",
  target: ["preview"],
  value: clusterUrl,
};
const proof = {
  actors: 8,
  artifactHash: "a".repeat(64),
  authenticatedBehavior: "unassessed",
  releaseId: "release_1",
  tenants: 2,
} as const;
const runtimeFiles = (): PrivateRuntimeFiles => ({
  "environment.json": JSON.stringify({
    APP_TEST_IDENTITIES_FILE: "/tmp/runtime/identities.json",
    BETTER_AUTH_APP_NAME: "apps",
    BETTER_AUTH_SECRET: "fixture-auth-secret",
    BETTER_AUTH_URL: "https://private.vercel.run",
    PLATFORM_AUTH_DATABASE_URL:
      "postgresql://builder_runtime_auth:fixture-auth@ep-owner.us-east-1.aws.neon.tech/builder_db_auth?sslmode=verify-full",
    SPEND_REVIEW_DATABASE_URL:
      "postgresql://builder_runtime:fixture-app@ep-owner.us-east-1.aws.neon.tech/builder_db?sslmode=verify-full",
  }),
  "identities.json": JSON.stringify({
    identities: [{ actorId: "requester", storageState: "/tmp/runtime/requester.storage.json" }],
  }),
  "requester.storage.json": JSON.stringify({ cookies: [{ value: "fixture-session-secret" }] }),
  "state.json": JSON.stringify({
    clusterUrl,
    plan: {
      appId: target.appId,
      authDatabase: "builder_db_auth",
      database: "builder_db",
      principal: "builder_runtime",
    },
    runtimePassword: "fixture-app",
  }),
});

const memoryStore = () => {
  const rows = new Map<string, HostedRuntimeJournalRow>();
  const store: HostedRuntimeJournalStore = {
    // oxlint-disable-next-line eslint/require-await -- Promise-returning journal fixture.
    async compareAndSet(input): Promise<HostedRuntimeJournalRow | undefined> {
      const key = hostedRuntimeIdentity(input.authority, input.target).digest;
      const row = rows.get(key);
      if (row?.revision !== input.expectedRevision) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- explicit absence is the CAS conflict result.
        return undefined;
      }
      const saved = { record: structuredClone(input.record), revision: row.revision + 1 };
      rows.set(key, saved);
      return structuredClone(saved);
    },
    // oxlint-disable-next-line eslint/require-await -- Promise-returning journal fixture.
    async read(input) {
      return structuredClone(rows.get(hostedRuntimeIdentity(input.authority, input.target).digest));
    },
    // oxlint-disable-next-line eslint/require-await -- Promise-returning journal fixture.
    async reserve(input) {
      const key = hostedRuntimeIdentity(input.authority, input.target).digest;
      const row = rows.get(key) ?? {
        record: {
          approvedByCallId: input.approvedByCallId,
          kind: "app-runtime",
          request: input.target,
          status: "pending",
          step: "reserved",
          version: 1,
        } satisfies HostedRuntimeJournalRecord,
        revision: 1,
      };
      rows.set(key, row);
      return structuredClone(row);
    },
    reserveFenceGeneration: async () => {},
  };
  return { rows, store };
};
const providerFixture = () => {
  const environments = [
    native,
    {
      ...native,
      configurationId: "",
      id: "env_guard",
      key: "AUTH_PRODUCTION_DATABASE_IDENTITY",
      value: "ep-production.us-east-1.aws.neon.tech/neondb",
    },
  ];
  // oxlint-disable-next-line eslint/require-await -- Promise-returning provider fixture.
  const request = vi.fn<typeof fetch>(async (resource, init) => {
    const url = new URL(resource instanceof Request ? resource.url : resource.toString());
    if (init?.method === "POST") {
      const values = z
        .array(
          z.object({
            comment: z.string(),
            gitBranch: z.string(),
            key: z.string(),
            target: z.array(z.string()),
            value: z.string(),
          }),
        )
        .parse(JSON.parse(z.string().parse(init.body)));
      for (const value of values) {
        const index = environments.findIndex((environment) => environment.key === value.key);
        const entry = { ...value, configurationId: "", id: `env_${value.key}` };
        if (index === -1) {
          environments.push(entry);
        } else {
          environments[index] = entry;
        }
      }
      return Response.json({ created: [], failed: [] });
    }
    if (url.pathname.endsWith("/env")) {
      return Response.json({ envs: environments });
    }
    const selected = environments.find((environment) =>
      url.pathname.endsWith(`/env/${environment.id}`),
    );
    return Response.json(
      selected ?? {
        accountId: target.scopeId,
        framework: "services",
        id: target.projectId,
        rootDirectory: ".",
      },
    );
  });
  return { environments, request };
};

describe("durable hosted runtime preparation", () => {
  it("checkpoints encrypted credentials before database mutation and binds only restricted runtime values", async () => {
    const { store } = memoryStore();
    const { environments, request } = providerFixture();
    let files: PrivateRuntimeFiles = {};
    const operations: string[] = [];
    const executor: HostedRuntimeExecutor = {
      // oxlint-disable-next-line eslint/require-await -- Promise-returning protected filesystem fixture.
      async capture() {
        return files;
      },
      // oxlint-disable-next-line eslint/require-await -- Promise-returning protected filesystem fixture.
      async restore(saved) {
        files = saved;
      },
      async run({ operation }) {
        operations.push(operation);
        if (operation === "checkpoint") {
          files = runtimeFiles();
        }
        if (operation === "prepare") {
          const row = await store.read({ authority, target });
          expect(row?.record.step).toBe("planned");
          expect(JSON.stringify(row)).not.toContain("fixture-admin-secret");
          expect(
            decryptHostedRuntimeFiles({
              authority,
              config,
              record: z.custom<HostedRuntimeJournalRecord>().parse(row?.record),
              target,
            })?.["state.json"],
          ).toContain("fixture-admin-secret");
        }
        return proof;
      },
    };
    const result = await prepareHostedRuntime({
      approvedByCallId: "approval_1",
      authority,
      config,
      executor,
      fetch: request,
      readCredential: async () => credential,
      store,
      target,
    });
    expect(result.status).toBe("prepared");
    // Branch bindings select restricted app URLs; native service env filtering remains unverified.
    expect(environments.find((value) => value.id === native.id)?.value).toBe(clusterUrl);
    expect(operations).toEqual(["checkpoint", "prepare", "verify"]);
    expect(result).toMatchObject({ proof: { authenticatedBehavior: "unassessed" } });
    expect(JSON.stringify(result)).not.toMatch(/fixture-(?:admin|auth|app|session)-secret/u);
    expect(environments.find((environment) => environment.key === "DATABASE_URL_UNPOOLED")).toEqual(
      native,
    );
    expect(environments.some((environment) => environment.key === "BETTER_AUTH_URL")).toBe(false);
    const row = await store.read({ authority, target });
    expect(row?.record).toMatchObject({ status: "prepared", step: "bound" });
    expect(row?.record.leaseId).toBeUndefined();
    if (row === undefined) {
      throw new Error("Expected a durable runtime journal.");
    }
    expect(() =>
      decryptHostedRuntimeFiles({
        authority: { ...authority, ownerUserId: "other_owner" },
        config,
        record: row.record,
        target,
      }),
    ).toThrow();
    const data = runtimeFiles();
    data["environment.json"] = JSON.stringify({
      ...z.record(z.string(), z.string()).parse(JSON.parse(data["environment.json"])),
      APP_RUNTIME_CLUSTER_DATABASE_URL: clusterUrl,
      APP_RUNTIME_STATE_DIR: "/private-installer-state",
      DATABASE_URL: clusterUrl,
    });
    const bindings = hostedRuntimeExecutionEnvironment(data, target.appId);
    expect(bindings.APP_RUNTIME_CLUSTER_DATABASE_URL).toBeUndefined();
    expect(bindings.APP_RUNTIME_STATE_DIR).toBeUndefined();
    expect(bindings.DATABASE_URL).toBe(bindings.PLATFORM_AUTH_DATABASE_URL);
    expect(bindings.DATABASE_URL_UNPOOLED).toBe(bindings.PLATFORM_AUTH_DATABASE_URL);
    expect(Object.values(bindings).some((value) => value.includes("fixture-admin-secret"))).toBe(
      false,
    );
  });

  it("recovers the same passwords into a replacement Sandbox after interrupted prepare", async () => {
    const { store } = memoryStore();
    const { request } = providerFixture();
    let files = runtimeFiles();
    let fail = true;
    const operations: string[] = [];
    const restore = vi.fn(async (saved: PrivateRuntimeFiles) => {
      files = saved;
    });
    const executor: HostedRuntimeExecutor = {
      capture: async () => files,
      restore,
      // oxlint-disable-next-line eslint/require-await -- Promise-returning repository fixture.
      async run({ operation }) {
        operations.push(operation);
        if (operation === "checkpoint") {
          expect(files).toEqual(runtimeFiles());
        }
        if (operation === "prepare" && fail) {
          throw new HostedRuntimeCommandError(operation, 1);
        }
        return proof;
      },
    };
    const input = {
      approvedByCallId: "approval_1",
      authority,
      config,
      executor,
      fetch: request,
      readCredential: async () => credential,
      store,
      target,
    };
    const failed = await prepareHostedRuntime(input);
    expect(failed.status).toBe("failed");
    files = {};
    fail = false;
    const recovered = await prepareHostedRuntime(input);
    expect(recovered.status).toBe("prepared");
    expect(restore).toHaveBeenCalledWith(runtimeFiles());
    expect(files["state.json"]).toContain("fixture-app");
    expect(operations).toEqual(["checkpoint", "prepare", "checkpoint", "prepare", "verify"]);
  });

  it("stops before database preparation or environment binding if the private checkpoint is absent", async () => {
    const { store } = memoryStore();
    const { request } = providerFixture();
    const run = vi.fn<HostedRuntimeExecutor["run"]>(async () => null);
    const result = await prepareHostedRuntime({
      approvedByCallId: "approval_1",
      authority,
      config,
      executor: { capture: async () => ({}), restore: async () => {}, run },
      fetch: request,
      readCredential: async () => credential,
      store,
      target,
    });

    expect(result).toEqual({
      appId: target.appId,
      code: "runtime_preparation_failed",
      status: "failed",
    });
    expect(run.mock.calls.map(([input]) => input.operation)).toEqual(["checkpoint"]);
    expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    const row = await store.read({ authority, target });
    expect(row?.record.privateState).toBeUndefined();
    expect(row?.record.leaseId).toBeUndefined();
  });

  it("rechecks revocation after checkpointing private state and before database writes", async () => {
    const { store } = memoryStore();
    const { request } = providerFixture();
    const run = vi.fn<HostedRuntimeExecutor["run"]>(async () => null);
    const result = await prepareHostedRuntime({
      approvedByCallId: "approval_1",
      authority,
      config,
      executor: { capture: async () => runtimeFiles(), restore: async () => {}, run },
      fetch: request,
      readCredential: vi.fn().mockResolvedValueOnce(credential).mockResolvedValueOnce(null),
      store,
      target,
    });

    expect(result).toEqual({
      appId: target.appId,
      code: "authorization_required",
      status: "blocked",
    });
    expect(run.mock.calls.map(([input]) => input.operation)).toEqual(["checkpoint"]);
    expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    const row = await store.read({ authority, target });
    expect(row?.record.step).toBe("planned");
    expect(row?.record.privateState).toBeDefined();
    expect(row?.record.leaseId).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain("fixture-admin-secret");
    if (row === undefined) {
      throw new Error("Expected a durable private checkpoint.");
    }
    expect(decryptHostedRuntimeFiles({ authority, config, record: row.record, target })).toEqual(
      runtimeFiles(),
    );
  });

  it("makes missing native connection a safe blocker without running repository mutations", async () => {
    const { store } = memoryStore();
    const executor = {
      capture: vi.fn(),
      restore: vi.fn(),
      run: vi.fn(),
    } satisfies HostedRuntimeExecutor;
    // oxlint-disable-next-line eslint/require-await -- Promise-returning provider fixture.
    const request = vi.fn<typeof fetch>(async (resource) => {
      const url = new URL(resource instanceof Request ? resource.url : resource.toString());
      if (url.pathname.includes("/env")) {
        return Response.json({ envs: [] });
      }
      return Response.json({
        accountId: target.scopeId,
        framework: "services",
        id: target.projectId,
        rootDirectory: ".",
      });
    });
    const result = await prepareHostedRuntime({
      approvedByCallId: "approval_1",
      authority,
      config,
      executor,
      fetch: request,
      readCredential: async () => credential,
      store,
      target,
    });
    expect(result).toEqual({ appId: target.appId, code: "connection_required", status: "blocked" });
    expect(executor.run).not.toHaveBeenCalled();
  });

  it("does not start a second mutating continuation while another preparation owns the lease", async () => {
    const { store } = memoryStore();
    const { request } = providerFixture();
    const { promise: started, resolve: preparing } = Promise.withResolvers<boolean>();
    const { promise: finish, resolve: finishPrepare } = Promise.withResolvers<boolean>();
    const run = vi.fn<HostedRuntimeExecutor["run"]>(async ({ operation }) => {
      if (operation === "prepare") {
        preparing(true);
        await finish;
      }
      return proof;
    });
    const executor = {
      capture: async () => runtimeFiles(),
      restore: async () => {},
      run,
    } satisfies HostedRuntimeExecutor;
    const input = {
      approvedByCallId: "approval_1",
      authority,
      config,
      executor,
      fetch: request,
      readCredential: async () => credential,
      store,
      target,
    };
    const first = prepareHostedRuntime(input);
    await started;
    const second = await prepareHostedRuntime(input);
    expect(second).toEqual({ appId: target.appId, status: "pending" });
    expect(run.mock.calls.filter(([call]) => call.operation === "prepare")).toHaveLength(1);
    finishPrepare(true);
    expect(await first).toMatchObject({ status: "prepared" });
  });

  it("rechecks revocation before publishing any runtime secrets", async () => {
    const { store } = memoryStore();
    const { request } = providerFixture();
    const readCredential = vi
      .fn()
      .mockResolvedValueOnce(credential)
      .mockResolvedValueOnce(credential)
      .mockResolvedValueOnce(null);
    const executor = {
      capture: async () => runtimeFiles(),
      restore: async () => {},
      run: async () => proof,
    } satisfies HostedRuntimeExecutor;
    const result = await prepareHostedRuntime({
      approvedByCallId: "approval_1",
      authority,
      config,
      executor,
      fetch: request,
      readCredential,
      store,
      target,
    });
    expect(result).toEqual({
      appId: target.appId,
      code: "authorization_required",
      status: "blocked",
    });
    expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("keeps runtime recovery scoped to owner, workspace, project, branch and session", () => {
    const { digest } = hostedRuntimeIdentity(authority, target);
    expect(
      hostedRuntimeIdentity({ ...authority, ownerUserId: "other_owner" }, target).digest,
    ).not.toBe(digest);
    for (const changed of [{ branch: "other" }, { projectId: "other" }, { sessionId: "other" }]) {
      expect(hostedRuntimeIdentity(authority, { ...target, ...changed }).digest).not.toBe(digest);
    }
    const { encryptedToken, tokenIv, tokenTag } = {
      encryptedToken: "invalid",
      tokenIv: "invalid",
      tokenTag: "invalid",
    };
    expect(() =>
      decryptHostedRuntimeFiles({
        authority,
        config,
        record: {
          approvedByCallId: "a",
          kind: "app-runtime",
          privateState: { encryptedToken, keyVersion: "old_key", tokenIv, tokenTag },
          request: target,
          status: "prepared",
          step: "bound",
          version: 1,
        },
        target,
      }),
    ).toThrow();
  });

  it("resumes a version-1 journal with its retained key and encrypts new checkpoints with the active key", () => {
    const rotatedConfig: VercelIntegrationConfig = {
      ...config,
      previousTokenKeys: [{ key: config.tokenKey, version: config.tokenKeyVersion }],
      tokenKey: Buffer.alloc(32, 10),
      tokenKeyVersion: "fixture_v2",
    };
    const associatedData = JSON.stringify({
      ...hostedRuntimeIdentity(authority, target),
      purpose: "app-runtime-private-state-v1",
    });
    const oldState = {
      ...encryptVercelToken({
        associatedData,
        key: config.tokenKey,
        token: JSON.stringify(runtimeFiles()),
      }),
      keyVersion: config.tokenKeyVersion,
    };
    const legacyRecord: HostedRuntimeJournalRecord = {
      approvedByCallId: "approval_legacy",
      kind: "app-runtime",
      privateState: oldState,
      request: target,
      status: "prepared",
      step: "bound",
      version: 1,
    };
    expect(
      decryptHostedRuntimeFiles({ authority, config: rotatedConfig, record: legacyRecord, target }),
    ).toEqual(runtimeFiles());

    const next = encryptHostedRuntimeFiles({
      authority,
      config: rotatedConfig,
      files: runtimeFiles(),
      target,
    });
    expect(next.keyVersion).toBe("fixture_v2");
    const nextRecord = { ...legacyRecord, privateState: next };
    expect(
      decryptHostedRuntimeFiles({ authority, config: rotatedConfig, record: nextRecord, target }),
    ).toEqual(runtimeFiles());
    expect(() =>
      decryptHostedRuntimeFiles({
        authority: { ...authority, ownerUserId: "other_owner" },
        config: rotatedConfig,
        record: legacyRecord,
        target,
      }),
    ).toThrow();
  });

  it("fails closed with authorization_required when a journal key version is unknown", () => {
    const record: HostedRuntimeJournalRecord = {
      approvedByCallId: "approval_legacy",
      kind: "app-runtime",
      privateState: {
        encryptedToken: "opaque-ciphertext",
        keyVersion: "removed_v0",
        tokenIv: "opaque-iv",
        tokenTag: "opaque-tag",
      },
      request: target,
      status: "prepared",
      step: "bound",
      version: 1,
    };
    let caught: unknown;
    try {
      decryptHostedRuntimeFiles({ authority, config, record, target });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "authorization_required" });
  });

  it("rejects installer credentials in an alleged runtime environment", () => {
    const files = runtimeFiles();
    const environment = z
      .record(z.string(), z.string())
      .parse(JSON.parse(files["environment.json"] ?? "null"));
    environment.SPEND_REVIEW_DATABASE_URL = clusterUrl;
    files["environment.json"] = JSON.stringify(environment);
    expect(() => hostedRuntimeBindings(files, target.appId)).toThrow(/installer or unrelated/u);
  });
});
