import { describe, expect, it } from "vitest";

import { createBuilderDraftOutbox } from "./builder-draft-outbox";

describe("builder draft outbox", () => {
  it("uses a memory recovery outbox when IndexedDB is unavailable", async () => {
    const outbox = createBuilderDraftOutbox<{ brief: string }>({
      key: `test-${crypto.randomUUID()}`,
      indexedDB: null,
    });

    await outbox.write({
      version: 1,
      mutationId: "first",
      snapshot: { brief: "first" },
      createdAt: 1,
    });
    await outbox.write({
      version: 1,
      mutationId: "second",
      snapshot: { brief: "second" },
      createdAt: 2,
    });

    await expect(outbox.clearIfMutationId("first")).resolves.toBe(false);
    await expect(outbox.read()).resolves.toMatchObject({
      mutationId: "second",
      snapshot: { brief: "second" },
    });
    await expect(outbox.clearIfMutationId("second")).resolves.toBe(true);
    await expect(outbox.read()).resolves.toBeUndefined();
  });
});
