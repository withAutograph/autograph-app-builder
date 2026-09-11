import { describe, expect, it } from "vitest";

import type {
  BuilderDraftRecord,
  SaveActiveBuilderDraftInput,
} from "./contracts";
import { createBuilderDraftService } from "./service";
import type {
  BuilderDraftAuthority,
  BuilderDraftRow,
  BuilderDraftStore,
} from "./service";

const authority: BuilderDraftAuthority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "user-one",
  workspaceId: "workspace-one",
};

const otherAuthority: BuilderDraftAuthority = {
  ...authority,
  workspaceId: "workspace-two",
};

const draftId = "00000000-0000-4000-8000-000000000001";
const otherDraftId = "00000000-0000-4000-8000-000000000002";
const firstMutation = "00000000-0000-4000-8000-000000000011";
const secondMutation = "00000000-0000-4000-8000-000000000012";

function sameAuthority(
  left: BuilderDraftAuthority,
  right: BuilderDraftAuthority
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function memoryStore(): BuilderDraftStore {
  const rows: BuilderDraftRow[] = [];
  const find = (input: { authority: BuilderDraftAuthority; draftId: string }) =>
    rows.find(
      (row) =>
        sameAuthority(row.authority, input.authority) &&
        row.draftId === input.draftId
    );
  const findActive = (input: { authority: BuilderDraftAuthority }) =>
    rows.find(
      (row) =>
        sameAuthority(row.authority, input.authority) && row.status === "active"
    );

  return {
    async archive(input) {
      const row = find(input);
      if (!row || row.status !== "active") return false;
      row.status = "archived";
      row.updatedAt = input.now;
      return true;
    },
    async deleteInactiveSince({ now, maxAgeMs }) {
      const cutoff = now.getTime() - (maxAgeMs ?? 30 * 24 * 60 * 60 * 1_000);
      let deleted = 0;
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        if (row.status === "active" && row.updatedAt.getTime() < cutoff) {
          rows.splice(index, 1);
          deleted += 1;
        }
      }
      return deleted;
    },
    async read(input) {
      return find(input);
    },
    async readActive(input) {
      return findActive(input);
    },
    async saveActive(input) {
      const active = findActive(input);
      if (active?.lastClientMutationId === input.clientMutationId)
        return { row: active, idempotent: true, concurrent: false };
      if (active) {
        const concurrent = active.revision !== input.expectedRevision;
        active.revision += 1;
        active.record = input.record;
        active.lastClientMutationId = input.clientMutationId;
        active.updatedAt = input.now;
        return { row: active, idempotent: false, concurrent };
      }
      const row: BuilderDraftRow = {
        authority: input.authority,
        draftId: input.draftId,
        status: "active",
        revision: 1,
        record: input.record,
        lastClientMutationId: input.clientMutationId,
        createdAt: input.now,
        updatedAt: input.now,
      };
      rows.push(row);
      return {
        row,
        idempotent: false,
        concurrent: input.expectedRevision !== 0,
      };
    },
  };
}

function record(brief = "A saved builder brief."): BuilderDraftRecord {
  return {
    draft: {
      appNameEditedByUser: false,
      connectedConnections: [],
      deploymentProvider: "vercel",
      focusOrigin: "github",
      form: {
        appName: "Vendor portal",
        brief,
        buildDestination: "codex",
        connections: [],
        modelId: "gpt-5",
        privateRepository: true,
        repository: "vendor-portal",
      },
      gitScope: "",
      model: "gpt-5",
      repositoryEditedByUser: false,
      search: "",
      showMoreConnections: false,
      storageProvider: "github",
      team: "",
      version: 1,
      zdrOnly: false,
    },
    version: 1,
  };
}

function saveInput(
  input: {
    draftId?: string;
    expectedRevision?: number;
    clientMutationId?: string;
    record?: BuilderDraftRecord;
  } = {}
): SaveActiveBuilderDraftInput {
  return {
    clientMutationId: input.clientMutationId ?? firstMutation,
    draftId: input.draftId ?? draftId,
    expectedRevision: input.expectedRevision ?? 0,
    record: input.record ?? record(),
    version: 1,
  };
}

describe("builder draft service", () => {
  it("isolates active drafts by tenant", async () => {
    const service = createBuilderDraftService({ store: memoryStore() });
    await service.saveActive(authority, saveInput());

    expect(await service.readActive(otherAuthority)).toBeUndefined();
    expect(await service.read(otherAuthority, draftId)).toBeUndefined();
  });

  it("uses one active draft, accepts stale completion-order saves, and retries idempotently", async () => {
    const service = createBuilderDraftService({ store: memoryStore() });
    const initial = saveInput();
    const first = await service.saveActive(authority, initial);
    expect(first.row.revision).toBe(1);
    const retry = await service.saveActive(authority, initial);
    const stale = await service.saveActive(
      authority,
      saveInput({
        clientMutationId: secondMutation,
        draftId: otherDraftId,
        record: record("The later device save wins."),
      })
    );
    expect(retry).toMatchObject({ concurrent: false, idempotent: true });
    expect(stale).toMatchObject({ concurrent: true, idempotent: false });
    expect(stale.row).toMatchObject({
      draftId,
      record: record("The later device save wins."),
      revision: 2,
    });
  });

  it("rejects malformed drafts before they reach storage", async () => {
    const service = createBuilderDraftService({ store: memoryStore() });
    const invalid = {
      ...saveInput(),
      record: { ...record(), unexpected: true },
    };

    await expect(
      service.saveActive(authority, invalid as SaveActiveBuilderDraftInput)
    ).rejects.toThrow();
  });

  it("scheduled cleanup removes only inactive active drafts", async () => {
    let time = new Date("2026-01-01T00:00:00.000Z");
    const service = createBuilderDraftService({
      now: () => time,
      store: memoryStore(),
    });
    await service.saveActive(authority, saveInput());
    time = new Date("2026-02-01T00:00:00.000Z");
    expect(await service.deleteInactiveSince()).toBe(1);

    await service.saveActive(authority, saveInput({ draftId: otherDraftId }));
    expect(await service.archive(authority, otherDraftId)).toBe(true);
    time = new Date("2026-04-01T00:00:00.000Z");
    expect(await service.deleteInactiveSince()).toBe(0);
  });
});
