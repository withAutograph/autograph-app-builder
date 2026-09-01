import { describe, expect, it } from "vitest";

import {
  createRepositoryAccessContinuationService,
  type RepositoryAccessContinuation,
  type RepositoryAccessContinuationStore,
} from "./repository-access-continuation";

const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace-1",
  ownerUserId: "user-1",
};
const continuationId = "1c7ed773-0aa9-4e32-9e65-6eb36e7b5cc0";

function sameAuthority(left: typeof authority, right: typeof authority) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function memoryStore(): RepositoryAccessContinuationStore & {
  records: RepositoryAccessContinuation[];
} {
  const records: RepositoryAccessContinuation[] = [];
  return {
    records,
    async create(record) {
      records.push(record);
    },
    async authorize(input) {
      const record = records.find(
        (candidate) =>
          candidate.continuationDigest === input.continuationDigest &&
          sameAuthority(candidate.authority, input.authority) &&
          candidate.authorizedAt === undefined &&
          candidate.consumedAt === undefined &&
          candidate.expiresAt > input.now,
      );
      if (!record) return undefined;
      record.authorizedAt = input.now;
      return record;
    },
    async consume(input) {
      const record = records.find(
        (candidate) =>
          candidate.continuationDigest === input.continuationDigest &&
          sameAuthority(candidate.authority, input.authority) &&
          candidate.sessionId === input.sessionId &&
          candidate.requestId === input.requestId &&
          candidate.repository.fullName === input.repository.fullName &&
          candidate.selectedInstallationId === input.selectedInstallationId &&
          candidate.authorizedAt !== undefined &&
          candidate.consumedAt === undefined &&
          candidate.expiresAt > input.now,
      );
      if (!record) return undefined;
      record.consumedAt = input.now;
      return record;
    },
    async listAuthorizedForSession(input) {
      return records.filter(
        (candidate) =>
          sameAuthority(candidate.authority, input.authority) &&
          candidate.sessionId === input.sessionId &&
          candidate.authorizedAt !== undefined &&
          candidate.consumedAt === undefined &&
          candidate.expiresAt > input.now,
      );
    },
  };
}

describe("GitHub repository access continuation", () => {
  it("binds one callback to the exact tenant, session, request, and repository", async () => {
    const store = memoryStore();
    let current = new Date("2026-09-01T12:00:00.000Z");
    const service = createRepositoryAccessContinuationService({
      store,
      now: () => current,
      createId: () => continuationId,
    });
    const created = await service.create({
      authority,
      sessionId: "ses_one",
      requestId: "call_one",
      repository: "withAutograph/app-builder-dogfood",
      selectedInstallationId: "10",
      callbackUrl:
        "https://builder.example/eve/v1/connections/github-repository-access/callback/attempt/token",
    });
    expect(created.continuationId).toBe(continuationId);
    expect(JSON.stringify(store.records)).not.toContain(continuationId);

    current = new Date("2026-09-01T12:01:00.000Z");
    await expect(
      service.authorize({ authority, continuationId }),
    ).resolves.toBe(
      "https://builder.example/eve/v1/connections/github-repository-access/callback/attempt/token?provider=github&status=connected",
    );
    await expect(
      service.consume({
        authority,
        continuationId,
        sessionId: "ses_one",
        requestId: "call_one",
        repository: "withAutograph/app-builder-dogfood",
        selectedInstallationId: "10",
      }),
    ).resolves.toMatchObject({
      sessionId: "ses_one",
      requestId: "call_one",
    });
    await expect(
      service.consume({
        authority,
        continuationId,
        sessionId: "ses_one",
        requestId: "call_one",
        repository: "withAutograph/app-builder-dogfood",
        selectedInstallationId: "10",
      }),
    ).resolves.toBeUndefined();
  });

  it("exposes only exact-tenant authorized callbacks for Check access recovery", async () => {
    const store = memoryStore();
    const service = createRepositoryAccessContinuationService({
      store,
      createId: () => continuationId,
      now: () => new Date("2026-09-01T12:00:00.000Z"),
    });
    await service.create({
      authority,
      sessionId: "ses_one",
      requestId: "call_one",
      repository: "withAutograph/app-builder-dogfood",
      callbackUrl:
        "https://builder.example/eve/v1/connections/github-repository-access/callback/attempt/token",
    });
    await service.authorize({ authority, continuationId });
    await expect(
      service.authorizedForSession({ authority, sessionId: "ses_one" }),
    ).resolves.toMatchObject([
      {
        record: {
          repository: { fullName: "withAutograph/app-builder-dogfood" },
        },
        callbackUrl:
          "https://builder.example/eve/v1/connections/github-repository-access/callback/attempt/token",
      },
    ]);
    await expect(
      service.authorizedForSession({
        authority: { ...authority, workspaceId: "workspace-2" },
        sessionId: "ses_one",
      }),
    ).resolves.toEqual([]);
  });

  it("rejects a wrong tenant, changed binding, expired callback, and replay", async () => {
    const store = memoryStore();
    let current = new Date("2026-09-01T12:00:00.000Z");
    const service = createRepositoryAccessContinuationService({
      store,
      now: () => current,
      createId: () => continuationId,
      lifetimeMs: 60_000,
    });
    await service.create({
      authority,
      sessionId: "ses_one",
      requestId: "call_one",
      repository: "withAutograph/app-builder-dogfood",
      callbackUrl:
        "https://builder.example/eve/v1/connections/github-repository-access/callback/attempt/token",
    });
    await expect(
      service.authorize({
        authority: { ...authority, workspaceId: "workspace-2" },
        continuationId,
      }),
    ).resolves.toBeUndefined();
    current = new Date("2026-09-01T12:00:30.000Z");
    await service.authorize({ authority, continuationId });
    await expect(
      service.consume({
        authority,
        continuationId,
        sessionId: "ses_other",
        requestId: "call_one",
        repository: "withAutograph/app-builder-dogfood",
      }),
    ).resolves.toBeUndefined();
    current = new Date("2026-09-01T12:02:00.000Z");
    await expect(
      service.consume({
        authority,
        continuationId,
        sessionId: "ses_one",
        requestId: "call_one",
        repository: "withAutograph/app-builder-dogfood",
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts only exact Eve callback routes on the canonical or loopback origin", async () => {
    const service = createRepositoryAccessContinuationService({
      store: memoryStore(),
      createId: () => continuationId,
    });
    for (const callbackUrl of [
      "https://attacker.example/eve/v1/connections/github/callback/a/b",
      "https://builder.example/not-eve",
      "https://builder.example/eve/v1/connections/github/callback/a/b?token=leak",
    ]) {
      await expect(
        service.create({
          authority,
          sessionId: "ses_one",
          requestId: "call_one",
          repository: "withAutograph/app-builder-dogfood",
          callbackUrl,
        }),
      ).rejects.toThrow("repository-access-callback-invalid");
    }
  });
});
