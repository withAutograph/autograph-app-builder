import { describe, expect, it } from "vitest";

import { originalCssSource } from "./css-source-map";

describe("CSS source-map provenance", () => {
  const map = {
    version: 3,
    sourceRoot: "../source",
    sources: ["src/generated.css", "packages/design-systems/shared.css"],
    // line 0 maps to generated.css:1, line 1 maps to shared.css:2.
    mappings: "AAAA;ACCA",
  };

  it("attributes only the exact mapped declaration line", () => {
    expect(originalCssSource(map, 0, 14)).toEqual({
      column: 1,
      line: 1,
      path: "../source/src/generated.css",
      sourceIndex: 0,
    });
    expect(originalCssSource(map, 1, 14)).toEqual({
      column: 1,
      line: 2,
      path: "../source/packages/design-systems/shared.css",
      sourceIndex: 1,
    });
  });

  it("leaves a generated line without a source mapping unassigned", () => {
    expect(originalCssSource(map, 2, 0)).toBeUndefined();
    expect(originalCssSource({ ...map, version: 2 }, 0, 0)).toBeUndefined();
  });

  it("does not inherit a preceding mapping across an explicit unmapped span", () => {
    expect(
      originalCssSource({ ...map, mappings: "AAAA,K" }, 0, 5)
    ).toBeUndefined();
  });

  it("fails closed for malformed source fields", () => {
    expect(
      originalCssSource(
        { ...map, sources: [null] } as unknown as typeof map,
        0,
        0
      )
    ).toBeUndefined();
    expect(
      originalCssSource(
        { ...map, sourceRoot: {} } as unknown as typeof map,
        0,
        0
      )
    ).toBeUndefined();
  });
});
