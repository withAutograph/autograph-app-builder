/* oxlint-disable eslint/require-await -- Private journal fixtures have no provider I/O. */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { realmIdentityNonceSha256 } from "./hosted-operator-auth-identity";
import {
  createNativeTargetAuthOnlyOwnerLink,
  nativeTargetAuthOnlyOwnerLinkBindingSchema,
} from "./native-target-auth-only-owner-link";
import type { NativeTargetAuthOnlyOwnerLinkStore } from "./native-target-auth-only-owner-link";

const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "owner-workspace",
  ownerUserId: "canonical-owner",
};
const operationRef = "44444444-4444-4444-a444-444444444444";
const binding = nativeTargetAuthOnlyOwnerLinkBindingSchema.parse({
  authority,
  target: {
    appId: "signup-pilot",
    branch: "pilot",
    environment: "preview",
    installationId: "icfg-owner",
    projectId: "prj-app",
    scopeId: "team-owner",
    scopeType: "team",
    sessionId: "saved-session",
  },
  operationRef,
  authOnlyPlanDigest: "a".repeat(64),
  resourcePlanDigest: "b".repeat(64),
  gatewayDeliveryPlanDigest: "c".repeat(64),
  gateway: {
    branch: "isolated-gateway",
    deploymentId: "dpl-ready",
    operationRef,
    origin: "https://immutable-gateway.example",
    projectId: "prj-gateway",
    readyState: "READY",
    repoId: "repo-approved",
  },
  sender: {
    issuer: "https://oidc.vercel.com/owner",
    audience: "https://vercel.com/owner",
    projectId: "prj-gateway",
    ownerId: "team-owner",
    subject: "owner:owner:project:gateway:environment:preview",
    environment: "preview",
  },
  browserOrigin: "https://auth-pilot.example",
  issuer: "https://auth-pilot.example",
  audience: "https://operator-preview.example",
  authResourceId: "isolated-auth",
  bootstrapResource: {
    environment: "preview",
    port: 5432,
    schema: "public",
    version: 1,
    database: "pilot_auth",
    hostname: "ep-pilot.neon.tech",
    migratorRole: "pilot_migrator",
    runtimeRole: "pilot_runtime",
    neon: { branchId: "br-pilot", projectId: "neon-pilot" },
  },
});
const proof = "opaque-proof-fixture-from-verified-callback";
const proofSha256 = createHash("sha256").update(proof).digest("hex");
const proofRef = `_protected-operator/artifacts/realm-identity-proof/${binding.target.appId}/${proofSha256}`;
const keyring = { tokenKey: Buffer.alloc(32, 1), tokenKeyVersion: "owner-key-1" };

type Row = NonNullable<Awaited<ReturnType<NativeTargetAuthOnlyOwnerLinkStore["read"]>>>;
const fixture = () => {
  let row: Row | undefined;
  const assertCurrent = vi.fn(async () => {});
  const readPublishedProof = vi.fn(async () => proof);
  const store: NativeTargetAuthOnlyOwnerLinkStore = {
    read: async () => (row === undefined ? undefined : structuredClone(row)),
    lookup: async (selector) =>
      row !== undefined &&
      row.record.link.ownerSessionId === selector.ownerSessionId &&
      row.record.link.nonceSha256 === selector.nonceSha256
        ? structuredClone(row)
        : undefined,
    compareAndSet: async (record, expectedRevision) => {
      if (row?.revision !== expectedRevision) return undefined;
      row = { record: structuredClone(record), revision: (expectedRevision ?? 0) + 1 };
      return structuredClone(row);
    },
  };
  const service = createNativeTargetAuthOnlyOwnerLink({
    store,
    keyring,
    assertCurrent,
    readPublishedProof,
  });
  const prepare = async () => {
    const result = await service.prepare(binding);
    if (result.status !== "waiting-for-owner") throw new Error("fixture invitation missing");
    const url = new URL(result.browserUrl);
    const nonce = url.searchParams.get("nonce")!;
    return {
      ...result,
      url,
      nonce,
      selector: {
        ownerSessionId: binding.target.sessionId,
        nonceSha256: realmIdentityNonceSha256(nonce),
      },
    };
  };
  return { service, assertCurrent, readPublishedProof, prepare, row: () => row };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-06T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Auth-only owner link", () => {
  it("keeps one sealed invitation across retries and exposes only the existing Auth link", async () => {
    const f = fixture();
    const [first, second] = await Promise.all([f.prepare(), f.prepare()]);
    expect(first.browserUrl).toBe(second.browserUrl);
    expect(first.url.origin).toBe(binding.browserOrigin);
    expect(first.url.pathname).toBe("/api/auth/platform/operator-link");
    expect(first.url.searchParams.get("ownerSessionId")).toBe(binding.target.sessionId);
    expect(first.url.searchParams.get("authResourceId")).toBe(binding.authResourceId);
    expect(first.url.searchParams.get("bootstrapPlanDigest")).toBe(binding.resourcePlanDigest);
    expect(f.row()?.revision).toBe(1);
    expect(JSON.stringify(f.row())).not.toContain(first.nonce);
    const pending = await f.service.readPending(first.selector);
    expect(pending).toMatchObject({
      binding,
      sender: binding.sender,
      bootstrapResource: binding.bootstrapResource,
      jwksUrl: "https://immutable-gateway.example/_platform/jwks.json",
    });
    expect(pending?.link).not.toHaveProperty("sealedNonce");
    expect(JSON.stringify(pending)).not.toContain(first.nonce);
  });

  it("rotates an expired pending nonce only within the same approved realm", async () => {
    const f = fixture();
    const first = await f.prepare();
    vi.advanceTimersByTime(15 * 60_000 + 1);
    await expect(f.service.readPending(first.selector)).rejects.toThrow("auth_identity_required");
    const second = await f.prepare();
    expect(second.selector.nonceSha256).not.toBe(first.selector.nonceSha256);
    expect(await f.service.readPending(first.selector)).toBeUndefined();
    expect(f.row()?.revision).toBe(2);
  });

  it("records one exact proof by CAS and denies replay", async () => {
    const f = fixture();
    const invitation = await f.prepare();
    const input = { binding, nonceSha256: invitation.selector.nonceSha256, proofRef, proofSha256 };
    const race = await Promise.allSettled([f.service.consume(input), f.service.consume(input)]);
    expect(race.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(f.row()?.record.link.sealedNonce).toBeUndefined();
    expect(JSON.stringify(f.row())).not.toContain(proof);
    expect(await f.service.readCaptured(binding)).toMatchObject({ proofRef, proofSha256 });
    await expect(f.service.readPending(invitation.selector)).rejects.toThrow(
      "auth_identity_required",
    );
    expect(await f.service.prepare(binding)).toEqual({
      status: "linked",
      operationRef,
      sessionId: binding.target.sessionId,
    });
    f.readPublishedProof.mockResolvedValue("changed-proof");
    await expect(f.service.readCaptured(binding)).rejects.toThrow("auth_identity_required");
  });

  it("requires the exact published proof bytes and namespace before consumption", async () => {
    const f = fixture();
    const invitation = await f.prepare();
    const input = { binding, nonceSha256: invitation.selector.nonceSha256, proofRef, proofSha256 };
    await expect(f.service.consume({ ...input, proofRef: "different-scope" })).rejects.toThrow(
      "auth_identity_required",
    );
    expect(f.readPublishedProof).not.toHaveBeenCalled();
    f.readPublishedProof.mockResolvedValue("wrong-proof");
    await expect(f.service.consume(input)).rejects.toThrow("auth_identity_required");
    expect(f.row()?.record.link.consumedAt).toBeUndefined();
  });

  it("rejects a foreign browser authority or replacement Gateway on the same operation", async () => {
    const f = fixture();
    const invitation = await f.prepare();
    await expect(
      f.service.readPending({
        ...invitation.selector,
        authority: { ...authority, ownerUserId: "someone-else" },
      }),
    ).rejects.toThrow("auth_identity_required");
    await expect(
      f.service.prepare({
        ...binding,
        gateway: { ...binding.gateway, deploymentId: "dpl-replacement" },
      }),
    ).rejects.toThrow("auth_identity_required");
    expect(await f.service.readPending(invitation.selector)).toBeDefined();
    expect(f.row()?.revision).toBe(1);
  });

  it("rechecks the canonical saved session after proof read and refuses a Stop race", async () => {
    const f = fixture();
    const invitation = await f.prepare();
    f.readPublishedProof.mockImplementation(async () => {
      f.assertCurrent.mockRejectedValue(new Error("owner session stopped"));
      return proof;
    });
    await expect(
      f.service.consume({
        binding,
        nonceSha256: invitation.selector.nonceSha256,
        proofRef,
        proofSha256,
      }),
    ).rejects.toThrow("owner session stopped");
    await expect(f.service.readPending(invitation.selector)).rejects.toThrow(
      "owner session stopped",
    );
    await expect(f.service.readCaptured(binding)).rejects.toThrow("owner session stopped");
    expect(f.row()?.record.link.consumedAt).toBeUndefined();
  });

  it("requires the exact isolated Preview sender and a READY Gateway", () => {
    expect(
      nativeTargetAuthOnlyOwnerLinkBindingSchema.safeParse({
        ...binding,
        sender: { ...binding.sender, projectId: binding.target.projectId },
      }).success,
    ).toBe(false);
    expect(
      nativeTargetAuthOnlyOwnerLinkBindingSchema.safeParse({
        ...binding,
        gateway: { ...binding.gateway, readyState: "BUILDING" },
      }).success,
    ).toBe(false);
    expect(
      nativeTargetAuthOnlyOwnerLinkBindingSchema.safeParse({
        ...binding,
        bootstrapResource: { ...binding.bootstrapResource, environment: "production" },
      }).success,
    ).toBe(false);
  });
});
