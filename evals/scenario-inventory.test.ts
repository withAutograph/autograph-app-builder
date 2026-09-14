import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import inventory from "./scenario-inventory.json";

describe("scenario inventory", () => {
  it("accounts for every Eve scenario exactly once", () => {
    const files = readdirSync(import.meta.dirname).filter((name) => name.endsWith(".eval.ts"));
    expect(inventory.map((row) => `${row.id}.eval.ts`).toSorted()).toEqual(files.toSorted());
    expect(new Set(inventory.map((row) => row.id)).size).toBe(inventory.length);
  });
  it("keeps real execution explicit and the internal self-reproduction diagnostic retired", () => {
    expect(inventory.filter((row) => row.execution === "sandbox").map((row) => row.id)).toEqual([
      "design-guidance",
      "sandbox-existing-iteration",
      "sandbox-identity-planning",
      "sandbox-reviewed-change-set",
      "sandbox-toolchain",
    ]);
    expect(inventory.filter((row) => row.execution === "deterministic")).toHaveLength(39);
    expect(inventory.filter((row) => row.execution === "retired").map((row) => row.id)).toEqual([
      "self-reproduction",
    ]);
    expect(
      inventory
        .filter((row) => row.execution === "deterministic")
        .every((row) =>
          ["general-enabled", "general-disabled", "fresh", "product"].includes(row.group),
        ),
    ).toBe(true);
  });
});
