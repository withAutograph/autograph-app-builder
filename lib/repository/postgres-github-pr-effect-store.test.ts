import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it, vi } from "vitest";

import {
  createGitHubPrEffectIntent,
  createGitHubPrEffectReceipt,
  githubPrEffectIntentDigest,
  parseGitHubPrEffectReceipt,
} from "./github-pr-effect-journal";
import { createPostgresGitHubPrEffectStore } from "./postgres-github-pr-effect-store";

const authority = {
  audience: "https://builder.example.test/mcp",
  issuer: "https://builder.example.test/api/auth",
  ownerUserId: "user_one",
  workspaceId: "workspace_one",
};
const intent = createGitHubPrEffectIntent({
  kind: "pr-merge",
  publicationDigest: "a".repeat(64),
  installationIdentityDigest: "b".repeat(64),
  repositoryId: "100",
  owner: "withAutograph",
  name: "example",
  pullRequestNumber: 42,
  headSha: "c".repeat(40),
  baseBranch: "main",
  readyAt: "2026-11-05T21:20:00.000Z",
});
const pending = createGitHubPrEffectReceipt({
  intent,
  approvedByCallId: "approved-call",
  status: "pending",
});
const succeeded = createGitHubPrEffectReceipt({
  intent,
  approvedByCallId: pending.approvedByCallId,
  status: "succeeded",
  evidence: { kind: "pr-merge", mergeCommitSha: "d".repeat(40) },
});

const databaseFixture = (rows: readonly (readonly (object | string)[])[] = []) => {
  // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
  const request = vi.fn((_sql: string, _params: readonly (object | string | number)[]) =>
    Promise.resolve({ rows: [...rows] }),
  );
  return { database: drizzle(request), request };
};

describe("tenant GitHub PR effect journal", () => {
  it("round-trips a canonical merge receipt and rejects tampering", () => {
    const reordered = Object.fromEntries(Object.entries(succeeded).toReversed());
    expect(parseGitHubPrEffectReceipt(reordered)).toEqual(succeeded);
    expect(() =>
      parseGitHubPrEffectReceipt({
        ...reordered,
        evidence: { kind: "pr-merge", mergeCommitSha: "e".repeat(40) },
      }),
    ).toThrow("canonical digest");
    expect(githubPrEffectIntentDigest({ ...intent, headSha: "e".repeat(40) })).not.toBe(
      pending.intentDigest,
    );
  });

  it("rejects evidence for a different effect and an invalid merge cycle", () => {
    expect(() =>
      createGitHubPrEffectReceipt({
        intent,
        approvedByCallId: pending.approvedByCallId,
        status: "succeeded",
        evidence: { kind: "pr-ready", readyAt: "2026-11-05T21:20:00.000Z" },
      }),
    ).toThrow("match the approved effect");
    expect(() =>
      createGitHubPrEffectIntent({ ...intent, kind: "pr-merge", readyAt: "invalid" }),
    ).toThrow();
  });

  it("claims pending once and terminal CAS retains tenant, effect and original call bindings", async () => {
    const fixture = databaseFixture([[pending.intentDigest]]);
    const store = createPostgresGitHubPrEffectStore(fixture.database, authority);
    await expect(store.compareAndSet(pending.intentDigest, undefined, pending)).resolves.toBe(true);
    const insertParams = fixture.request.mock.calls[0]?.[1];
    expect(insertParams).toEqual(
      expect.arrayContaining([
        authority.issuer,
        authority.audience,
        authority.workspaceId,
        authority.ownerUserId,
        "pr-merge",
        pending.intentDigest,
        "pending",
      ]),
    );
    await expect(
      store.compareAndSet(pending.intentDigest, pending.digest, succeeded),
    ).resolves.toBe(true);
    const updateParams = fixture.request.mock.calls[1]?.[1];
    expect(updateParams?.slice(-9)).toEqual([
      authority.issuer,
      authority.audience,
      authority.workspaceId,
      authority.ownerUserId,
      pending.intentDigest,
      "pr-merge",
      "pending",
      pending.digest,
      pending.approvedByCallId,
    ]);
    const collision = createPostgresGitHubPrEffectStore(databaseFixture().database, authority);
    await expect(collision.compareAndSet(pending.intentDigest, undefined, pending)).resolves.toBe(
      false,
    );
    await expect(store.compareAndSet(pending.intentDigest, undefined, succeeded)).rejects.toThrow(
      "Invalid GitHub effect journal transition",
    );
    await expect(
      store.compareAndSet(pending.intentDigest, pending.digest, pending),
    ).rejects.toThrow("Invalid GitHub effect journal transition");
  });

  it("reads scoped effect rows and rejects a mismatched indexed receipt", async () => {
    const row = [succeeded.intent.kind, succeeded.digest, succeeded, succeeded.status];
    const fixture = databaseFixture([row]);
    const store = createPostgresGitHubPrEffectStore(fixture.database, authority);
    await expect(store.read(succeeded.intentDigest)).resolves.toEqual(succeeded);
    expect(fixture.request.mock.calls[0]?.[1]).toEqual([
      authority.issuer,
      authority.audience,
      authority.workspaceId,
      authority.ownerUserId,
      succeeded.intentDigest,
      1,
    ]);
    const mismatched = databaseFixture([["pr-ready", ...row.slice(1)]]);
    await expect(
      createPostgresGitHubPrEffectStore(mismatched.database, authority).read(
        succeeded.intentDigest,
      ),
    ).rejects.toThrow("does not match its journal row");
  });
});
