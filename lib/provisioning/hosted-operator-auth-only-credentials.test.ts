/* oxlint-disable eslint/require-await -- In-memory durable-store fixtures exercise custody without providers. */
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createHostedOperatorAuthOnlyCredentials,
  authOnlyCredentialContextSchema,
} from "./hosted-operator-auth-only-credentials";
import type {
  AuthOnlyCredentialContext,
  AuthOnlyCredentialRecord,
  AuthOnlyCredentialRef,
  AuthOnlyCredentialStore,
} from "./hosted-operator-auth-only-credentials";
import { centralHostCanonicalBytes } from "./central-integration-host-contract";
import { HostedOperatorError } from "./hosted-operator-contract";

const context = authOnlyCredentialContextSchema.parse({
  appId: "pilot",
  authority: {
    audience: "https://builder.example/mcp",
    issuer: "https://builder.example/api/auth",
    ownerUserId: "owner",
    workspaceId: "workspace",
  },
  operationRef: "11111111-1111-4111-a111-111111111111",
  profile: { authorityDigest: "a".repeat(64), id: "pilot-profile" },
  resource: {
    database: "pilot_auth",
    environment: "preview",
    migratorRole: "pilot_migrator",
    neon: {
      branchId: "isolated-branch",
      endpointId: "ep-isolated",
      hostname: "ep-isolated.us-east-1.aws.neon.tech",
      projectId: "isolated-project",
    },
    resourceId: "isolated-auth",
    runtimeRole: "pilot_runtime",
  },
  sessionId: "saved-pilot-session",
});
const credentials = {
  migratorPassword: `migration:@/%?${"m".repeat(32)}`,
  runtimePassword: `runtime:@/%?${"r".repeat(32)}`,
};
const keyring = { tokenKey: Buffer.alloc(32, 9), tokenKeyVersion: "fixture_v1" };
const hash = (value: AuthOnlyCredentialContext | AuthOnlyCredentialRecord) =>
  createHash("sha256")
    .update(centralHostCanonicalBytes(z.json().parse(value)))
    .digest("hex");
const fixture = () => {
  const records = new Map<string, AuthOnlyCredentialRecord>();
  const store = {
    read: vi.fn<AuthOnlyCredentialStore["read"]>(async (key) => {
      const record = records.get(key.contextDigest);
      return record === undefined ? undefined : structuredClone(record);
    }),
    writeIfAbsent: vi.fn<AuthOnlyCredentialStore["writeIfAbsent"]>(async (key, record) => {
      if (records.has(key.contextDigest)) {
        return "exists";
      }
      records.set(key.contextDigest, structuredClone(record));
      return "written";
    }),
  };
  const assertCurrent = vi.fn(async (_context: AuthOnlyCredentialContext) => ({
    authorityDigest: context.profile.authorityDigest,
    resource: context.resource,
  }));
  const custody = createHostedOperatorAuthOnlyCredentials({ keyring, store });
  const input = {
    assertCurrent,
    context: structuredClone(context),
    credentials: { ...credentials },
  };
  return { assertCurrent, custody, input, records, store };
};

it("seals only Auth credentials, confirms durable custody and returns private role-scoped URLs", async () => {
  const f = fixture();
  const reference = await f.custody.seal(f.input);
  expect(f.store.writeIfAbsent).toHaveBeenCalledOnce();
  expect(f.store.read).toHaveBeenCalledTimes(2);
  const stored = JSON.stringify([...f.records.values()]);
  for (const secret of Object.values(credentials)) {
    expect(stored).not.toContain(secret);
    expect(JSON.stringify(reference)).not.toContain(secret);
  }
  const result = await f.custody.read({ ...f.input, reference });
  for (const [name, role, secret] of [
    ["migrationUrl", context.resource.migratorRole, credentials.migratorPassword],
    ["runtimeUrl", context.resource.runtimeRole, credentials.runtimePassword],
  ] as const) {
    const url = new URL(result[name]);
    expect(url.hostname).toBe(context.resource.neon.hostname);
    expect(decodeURIComponent(url.pathname.slice(1))).toBe(context.resource.database);
    expect(decodeURIComponent(url.username)).toBe(role);
    expect(decodeURIComponent(url.password)).toBe(secret);
    expect(url.searchParams.get("sslmode")).toBe("verify-full");
  }
  const pooled = await f.custody.read({ ...f.input, reference, runtimeConnection: "pooled" });
  expect(new URL(pooled.migrationUrl).hostname).toBe(context.resource.neon.hostname);
  expect(new URL(pooled.runtimeUrl).hostname).toBe("ep-isolated-pooler.us-east-1.aws.neon.tech");
  expect(f.store.writeIfAbsent).toHaveBeenCalledOnce();
});

it("reuses identical saved ciphertext and refuses password replacement on retry", async () => {
  const f = fixture();
  const original = await f.custody.seal(f.input);
  expect(await f.custody.seal(f.input)).toEqual(original);
  await expect(
    f.custody.seal({
      ...f.input,
      credentials: { ...credentials, runtimePassword: "changed".repeat(8) },
    }),
  ).rejects.toThrow("resource_mismatch");
  expect(f.store.writeIfAbsent).toHaveBeenCalledOnce();
  expect(await f.custody.read({ ...f.input, reference: original })).toHaveProperty("runtimeUrl");
});

it("does not return a reference when a reported write has no durable read-back", async () => {
  const f = fixture();
  f.store.writeIfAbsent.mockResolvedValue("written");
  await expect(f.custody.seal(f.input)).rejects.toThrow("operation_in_progress");
});

it("rejects a changed ciphertext after a reported successful insert", async () => {
  const f = fixture();
  f.store.writeIfAbsent.mockImplementation(async (key, record) => {
    f.records.set(key.contextDigest, {
      ...record,
      privateState: { ...record.privateState, encryptedToken: "changed" },
    });
    return "written";
  });
  await expect(f.custody.seal(f.input)).rejects.toThrow("operation_in_progress");
});

it("recovers a lost write response by reading the same saved record, without rotating passwords", async () => {
  const f = fixture();
  f.store.writeIfAbsent.mockImplementationOnce(async (key, record) => {
    f.records.set(key.contextDigest, structuredClone(record));
    throw new Error("private provider detail");
  });
  await expect(f.custody.seal(f.input)).rejects.toThrow("operator_unavailable");
  const reference = await f.custody.seal(f.input);
  expect(f.store.writeIfAbsent).toHaveBeenCalledOnce();
  expect(await f.custody.read({ ...f.input, reference })).toHaveProperty("migrationUrl");
});

it("reuses a concurrent winner only when its sealed credentials match", async () => {
  const missingRecord = undefined;
  const f = fixture();
  const reference = await f.custody.seal(f.input);
  f.store.read.mockResolvedValueOnce(missingRecord);
  expect(await f.custody.seal(f.input)).toEqual(reference);
  f.store.read.mockResolvedValueOnce(missingRecord);
  await expect(
    f.custody.seal({
      ...f.input,
      credentials: { ...credentials, migratorPassword: "different".repeat(8) },
    }),
  ).rejects.toThrow("resource_mismatch");
});

it.each([
  "owner",
  "workspace",
  "session",
  "app",
  "operation",
  "profile",
  "authority-digest",
  "resource",
  "database",
  "migrator",
  "runtime",
  "project",
  "branch",
  "endpoint",
  "hostname",
] as const)("rejects a reference in a different %s context", async (field) => {
  const f = fixture();
  const reference = await f.custody.seal(f.input);
  const changed = structuredClone(context);
  if (field === "owner") {
    changed.authority.ownerUserId = "other";
  }
  if (field === "workspace") {
    changed.authority.workspaceId = "other";
  }
  if (field === "session") {
    changed.sessionId = "other";
  }
  if (field === "app") {
    changed.appId = "other";
  }
  if (field === "operation") {
    changed.operationRef = "22222222-2222-4222-a222-222222222222";
  }
  if (field === "profile") {
    changed.profile.id = "other";
  }
  if (field === "authority-digest") {
    changed.profile.authorityDigest = "b".repeat(64);
  }
  if (field === "resource") {
    changed.resource.resourceId = "other";
  }
  if (field === "database") {
    changed.resource.database = "other";
  }
  if (field === "migrator") {
    changed.resource.migratorRole = "other";
  }
  if (field === "runtime") {
    changed.resource.runtimeRole = "other";
  }
  if (field === "project") {
    changed.resource.neon.projectId = "other";
  }
  if (field === "branch") {
    changed.resource.neon.branchId = "other";
  }
  if (field === "endpoint") {
    changed.resource.neon.endpointId = "other";
  }
  if (field === "hostname") {
    changed.resource.neon.hostname = "ep-other.neon.tech";
  }
  f.store.read.mockClear();
  await expect(f.custody.read({ ...f.input, context: changed, reference })).rejects.toThrow(
    "resource_mismatch",
  );
  expect(f.store.read).not.toHaveBeenCalled();
});

it("cryptographically rejects a transplanted ciphertext even when its public record and reference are rewritten", async () => {
  const f = fixture();
  const original = await f.custody.seal(f.input);
  const record = f.records.get(original.contextDigest);
  if (record === undefined) {
    throw new Error("Expected sealed credential record before transplanting it");
  }
  const changed = { ...context, operationRef: "22222222-2222-4222-a222-222222222222" };
  const forged = { ...record, context: changed };
  const reference: AuthOnlyCredentialRef = {
    ...original,
    contextDigest: hash(changed),
    recordDigest: hash(forged),
  };
  f.records.set(reference.contextDigest, forged);
  await expect(f.custody.read({ ...f.input, context: changed, reference })).rejects.toThrow(
    "resource_mismatch",
  );
});

it("does not release credentials for a missing record or altered reference", async () => {
  const f = fixture();
  const reference = await f.custody.seal(f.input);
  await expect(
    f.custody.read({ ...f.input, reference: { ...reference, recordDigest: "f".repeat(64) } }),
  ).rejects.toThrow("resource_mismatch");
  f.records.clear();
  await expect(f.custody.read({ ...f.input, reference })).rejects.toThrow("resource_mismatch");
  expect(f.store.writeIfAbsent).toHaveBeenCalledOnce();
});

it("requires the actual current profile authority digest before writing or reading credentials", async () => {
  const f = fixture();
  f.assertCurrent.mockResolvedValue({
    authorityDigest: "b".repeat(64),
    resource: context.resource,
  });
  await expect(f.custody.seal(f.input)).rejects.toThrow("authorization_required");
  expect(f.store.read).not.toHaveBeenCalled();
  expect(f.store.writeIfAbsent).not.toHaveBeenCalled();
});

it("rejects the correct profile digest paired with a different actual resource", async () => {
  const f = fixture();
  f.assertCurrent.mockResolvedValue({
    authorityDigest: context.profile.authorityDigest,
    resource: { ...context.resource, database: "other_auth" },
  });
  await expect(f.custody.seal(f.input)).rejects.toThrow("authorization_required");
  expect(f.store.read).not.toHaveBeenCalled();
  expect(f.store.writeIfAbsent).not.toHaveBeenCalled();
});

it("retains committed custody but returns no reference when authority is lost after the write", async () => {
  const f = fixture();
  f.store.writeIfAbsent.mockImplementationOnce(async (key, record) => {
    f.records.set(key.contextDigest, structuredClone(record));
    f.assertCurrent.mockRejectedValue(new Error("lease lost"));
    return "written";
  });
  await expect(f.custody.seal(f.input)).rejects.toThrow("authorization_required");
  expect(f.records.size).toBe(1);
  f.assertCurrent.mockResolvedValue({
    authorityDigest: context.profile.authorityDigest,
    resource: context.resource,
  });
  expect(await f.custody.seal(f.input)).toHaveProperty("recordDigest");
  expect(f.store.writeIfAbsent).toHaveBeenCalledOnce();
});

it("rejects invalid secrets before any private-store operation", async () => {
  const f = fixture();
  await expect(
    f.custody.seal({ ...f.input, credentials: { ...credentials, migratorPassword: "too-short" } }),
  ).rejects.toThrow("resource_mismatch");
  expect(f.store.read).not.toHaveBeenCalled();
  expect(f.store.writeIfAbsent).not.toHaveBeenCalled();
});

it("withholds credentials if authority changes during durable read", async () => {
  const f = fixture();
  const reference = await f.custody.seal(f.input);
  f.assertCurrent.mockClear();
  f.assertCurrent
    .mockResolvedValueOnce({
      authorityDigest: context.profile.authorityDigest,
      resource: context.resource,
    })
    .mockResolvedValue({ authorityDigest: "b".repeat(64), resource: context.resource });
  await expect(f.custody.read({ ...f.input, reference })).rejects.toThrow("authorization_required");
});

it("uses only an explicitly retained key version and never rewrites custody while reading", async () => {
  const f = fixture();
  const reference = await f.custody.seal(f.input);
  const nextKeyring = { tokenKey: Buffer.alloc(32, 4), tokenKeyVersion: "fixture_v2" };
  const revoked = createHostedOperatorAuthOnlyCredentials({ keyring: nextKeyring, store: f.store });
  await expect(revoked.read({ ...f.input, reference })).rejects.toThrow("authorization_required");
  const rotated = createHostedOperatorAuthOnlyCredentials({
    keyring: {
      ...nextKeyring,
      previousTokenKeys: [{ key: keyring.tokenKey, version: keyring.tokenKeyVersion }],
    },
    store: f.store,
  });
  expect(await rotated.read({ ...f.input, reference })).toHaveProperty("runtimeUrl");
  expect(f.store.writeIfAbsent).toHaveBeenCalledOnce();
});

it("snapshots supplied context, credentials and key bytes before asynchronous storage", async () => {
  const f = fixture();
  const ownedKeyring = { ...keyring, tokenKey: Buffer.from(keyring.tokenKey) };
  const custody = createHostedOperatorAuthOnlyCredentials({
    keyring: ownedKeyring,
    store: f.store,
  });
  f.assertCurrent.mockImplementationOnce(async () => {
    f.input.context.resource.database = "other";
    f.input.credentials.runtimePassword = "other".repeat(8);
    ownedKeyring.tokenKey.fill(0);
    return { authorityDigest: context.profile.authorityDigest, resource: context.resource };
  });
  const reference = await custody.seal(f.input);
  const actual = await custody.read({ assertCurrent: f.assertCurrent, context, reference });
  expect(decodeURIComponent(new URL(actual.runtimeUrl).password)).toBe(credentials.runtimePassword);
  expect(new URL(actual.runtimeUrl).pathname).toBe("/pilot_auth");
});

it("does not expose private store errors", async () => {
  const f = fixture();
  f.store.read.mockRejectedValue(new Error(credentials.runtimePassword));
  await expect(f.custody.seal(f.input)).rejects.toThrow("operator_unavailable");
});

it("preserves a typed lease or reconciliation denial without requesting new authority", async () => {
  const f = fixture();
  f.assertCurrent.mockRejectedValue(new HostedOperatorError("reconciliation_required"));
  await expect(f.custody.seal(f.input)).rejects.toThrow("reconciliation_required");
  expect(f.store.read).not.toHaveBeenCalled();
});
