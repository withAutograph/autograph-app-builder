import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { expect, test } from "playwright/test";

import { createBuilderDraftStore } from "../../lib/db/builder-drafts";
import * as schema from "../../lib/db/schema";
import type { BuilderDraftRecord } from "../../lib/builder-drafts/contracts";
import { databaseUrl, resetApplicationState } from "../support/harness";

const authority = {
  issuer: "https://draft-store.test/api/auth",
  audience: "https://draft-store.test/mcp",
  workspaceId: "draft-race-workspace",
  ownerUserId: "draft-race-owner",
};
function record(brief: string): BuilderDraftRecord {
  return {
    version: 1,
    draft: {
      version: 1,
      form: {
        appName: "Saved app",
        repository: "saved-app",
        brief,
        privateRepository: true,
        buildDestination: "codex",
        connections: [],
        modelId: "openai/gpt-5.6-terra",
      },
      team: "",
      gitScope: "",
      model: "openai/gpt-5.6-terra",
      zdrOnly: false,
      showMoreConnections: false,
      search: "",
      connectedConnections: [],
      storageProvider: null,
      deploymentProvider: null,
      focusOrigin: "github",
      appNameEditedByUser: true,
      repositoryEditedByUser: true,
    },
  };
}
function saveInput(draftId: string, brief: string, expectedRevision = 0) {
  return {
    authority,
    draftId,
    record: record(brief),
    expectedRevision,
    clientMutationId: randomUUID(),
    now: new Date(),
  };
}

test.beforeEach(async () => resetApplicationState());

test("PostgreSQL serializes draft save/archive races without resurrecting a handoff draft", async () => {
  const client = postgres(databaseUrl, { max: 4 });
  const store = createBuilderDraftStore(drizzle(client, { schema }));
  try {
    const draftId = randomUUID();
    await store.saveActive(saveInput(draftId, "Handed-off intent"));
    const [save, archive] = await Promise.allSettled([
      store.saveActive(saveInput(draftId, "Concurrent device edit", 1)),
      store.archive({ authority, draftId, expectedRevision: 1, now: new Date() }),
    ]);
    expect(archive.status).toBe("fulfilled");
    if (save.status === "fulfilled") {
      expect(archive).toMatchObject({ value: false });
      expect(await store.readActive({ authority })).toMatchObject({
        revision: 2,
        record: record("Concurrent device edit"),
      });
      expect(
        await store.archive({ authority, draftId, expectedRevision: 2, now: new Date() }),
      ).toBe(true);
    } else {
      expect(archive).toMatchObject({ value: true });
      expect(String(save.reason)).toContain("builder-draft-archived");
    }
    expect(await store.readActive({ authority })).toBeUndefined();
    const newDraftId = randomUUID();
    await store.saveActive(saveInput(newDraftId, "A fresh builder"));
    // A page-hide retry may still carry revision zero from an interrupted
    // first response. Even that request cannot overwrite the new active draft.
    for (const revision of [0, 1]) {
      await expect(
        store.saveActive(saveInput(draftId, "Delayed old tab", revision)),
      ).rejects.toThrow("builder-draft-archived");
    }
    expect(await store.readActive({ authority })).toMatchObject({
      draftId: newDraftId,
      revision: 1,
      record: record("A fresh builder"),
    });
    expect(await store.read({ authority, draftId })).toMatchObject({ status: "archived" });
  } finally {
    await client.end();
  }
});

test("PostgreSQL keeps one active draft across simultaneous device creation and rejects purged revisions", async () => {
  const client = postgres(databaseUrl, { max: 4 });
  const store = createBuilderDraftStore(drizzle(client, { schema }));
  try {
    const [first, second] = await Promise.all([
      store.saveActive(saveInput(randomUUID(), "Device A")),
      store.saveActive(saveInput(randomUUID(), "Device B")),
    ]);
    expect(first.row.draftId).toBe(second.row.draftId);
    expect([first.row.revision, second.row.revision].sort()).toEqual([1, 2]);
    const current = await store.readActive({ authority });
    expect(current?.revision).toBe(2);
    await expect(
      store.saveActive(saveInput(randomUUID(), "Expired device outbox", 3)),
    ).rejects.toThrow("builder-draft-stale");
    expect(await store.readActive({ authority })).toEqual(current);
    expect(
      await store.read({
        authority: { ...authority, workspaceId: "different-workspace" },
        draftId: current!.draftId,
      }),
    ).toBeUndefined();
  } finally {
    await client.end();
  }
});
