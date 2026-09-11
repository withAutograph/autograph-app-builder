import { describe, expect, it } from "vitest";

import {
  createPreviewEmulatePersistence,
  type PreviewEmulateStateStore,
} from "./preview-emulate-persistence";

function memoryStore(): PreviewEmulateStateStore & {
  states: Map<string, string>;
} {
  const states = new Map<string, string>();
  return {
    states,
    async read(namespace) {
      return states.get(namespace);
    },
    async write(namespace, state) {
      states.set(namespace, state);
    },
    async reset(namespace) {
      return states.delete(namespace) ? 1 : 0;
    },
  };
}

describe("Preview Emulate persistence", () => {
  it("isolates state by branch namespace and restores saved state", async () => {
    const store = memoryStore();
    const first = createPreviewEmulatePersistence({
      namespace: "repo:prj:a",
      store,
    });
    const second = createPreviewEmulatePersistence({
      namespace: "repo:prj:b",
      store,
    });
    expect(await first.load()).toBeNull();
    await first.save('{"collections":{"github":[]}}');
    expect(await first.load()).toBe('{"collections":{"github":[]}}');
    expect(await second.load()).toBeNull();
  });

  it("fails closed for malformed persisted state", async () => {
    const store = memoryStore();
    store.states.set("repo:prj:a", "not-json");
    const persistence = createPreviewEmulatePersistence({
      namespace: "repo:prj:a",
      store,
    });
    await expect(persistence.load()).rejects.toThrow("state is invalid");
    await expect(persistence.save("null")).rejects.toThrow("state is invalid");
  });
});
