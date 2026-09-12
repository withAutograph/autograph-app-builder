import { describe, expect, it } from "vitest";

import { createPreviewEmulatePersistence } from "./preview-emulate-persistence";
import type { PreviewEmulateStateStore } from "./preview-emulate-persistence";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function memoryStore(): PreviewEmulateStateStore & {
  states: Map<string, string>;
} {
  const states = new Map<string, string>();
  return {
    states,
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    async read(namespace) {
      return states.get(namespace);
    },
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    async write(namespace, state) {
      states.set(namespace, state);
    },
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
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
