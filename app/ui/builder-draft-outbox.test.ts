import { describe, expect, it } from "vitest";

import { createBuilderDraftOutbox } from "./builder-draft-outbox";

describe("builder draft outbox", () => {
  it("uses a memory recovery outbox when IndexedDB is unavailable", async () => {
    const outbox = createBuilderDraftOutbox<{ brief: string }>({
      indexedDB: null,
      key: `test-${crypto.randomUUID()}`,
    });

    await outbox.write({
      createdAt: 1,
      mutationId: "first",
      snapshot: { brief: "first" },
      version: 1,
    });
    await outbox.write({
      createdAt: 2,
      mutationId: "second",
      snapshot: { brief: "second" },
      version: 1,
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
