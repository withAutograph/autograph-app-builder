import { describe, expect, it } from "vitest";
import {
  arrustedSharedSource,
  captureViewports,
  classifyStyle,
  generatedSource,
  mappedSharedCssRule,
  parseAdditionalDesktopSize,
  scenariosSchema,
  sourcePath,
} from "./browser";
import { collectCssRuleEvidence } from "./css-evidence";
import { escapeHtml, renderReport } from "./report";
describe("conservative design measurements", () => {
  it("keeps token references distinct from lookalikes", () => {
    expect(
      classifyStyle(["var(--color-text-primary)"], "rgb(41, 41, 41)", []),
    ).toBe("token-reference");
    expect(
      classifyStyle(["#292929"], "rgb(41, 41, 41)", ["rgb(41, 41, 41)"]),
    ).toBe("matching-literal");
    expect(classifyStyle(["#123456"], "rgb(18, 52, 86)", [])).toBe(
      "unmatched-literal",
    );
    expect(classifyStyle(["var(--a)", "#292929"], "rgb(41, 41, 41)", [])).toBe(
      "unassessed",
    );
    expect(classifyStyle([], "rgb(41, 41, 41)", [])).toBe("unassessed");
  });
  it("does not punish structural layout choices", () => {
    for (const v of ["0px", "auto", "50%", "1fr 2fr"])
      expect(classifyStyle([v], v, [])).toBe("structural");
  });
  it("parses only declared fixture actions", () => {
    expect(
      scenariosSchema.safeParse([
        { name: "test", steps: [{ action: "publish", selector: "button" }] },
      ]).success,
    ).toBe(false);
  });
  it("accepts an opt-in desktop size without adding a width requirement", () => {
    expect(parseAdditionalDesktopSize("960x700")).toEqual({
      width: 960,
      height: 700,
    });
    for (const value of ["960", "960X700", "0x700", "960x0", "960x700px"])
      expect(() => parseAdditionalDesktopSize(value)).toThrow();
    expect(captureViewports().map((viewport) => viewport.name)).toEqual([
      "desktop",
      "desktop-wide",
      "desktop-window",
    ]);
    expect(captureViewports({ width: 960, height: 700 }).at(-1)).toMatchObject({
      name: "desktop-custom-960x700",
      width: 960,
      height: 700,
    });
  });
  it("attributes a stylesheet only when its source URL matches an explicit generated path", () => {
    expect(
      sourcePath("https://preview.example/app.css?token=secret#hash"),
    ).toBe("/app.css");
    expect(
      generatedSource("/workspace/apps/generated/app.css", [
        "apps/generated/app.css",
      ]),
    ).toBe(true);
    expect(
      generatedSource("/workspace/packages/design-systems/theme.css", [
        "apps/generated/app.css",
      ]),
    ).toBe(false);
    expect(generatedSource(undefined, ["apps/generated/app.css"])).toBe(false);
    expect(
      arrustedSharedSource("/workspace/packages/design-systems/theme.css"),
    ).toBe(true);
    expect(arrustedSharedSource("/workspace/apps/preview/app.css")).toBe(false);
  });
  it("verifies mapped shared CSS by exact file bytes and declaration location", () => {
    const path = "packages/design-systems/core/card.css";
    const content = ".card {\n  color: var(--color-text-primary);\n}";
    const rules = collectCssRuleEvidence([{ path, content }]);
    const mapped = { path, line: 2, column: 3, sourceIndex: 0 };
    const map = {
      version: 3,
      sources: [path],
      sourcesContent: [content],
      mappings: "",
    };
    const input = {
      map,
      mapped,
      property: "color",
      value: "var(--color-text-primary)",
      sharedCssRules: rules,
      sharedCssSourceFiles: [{ path, content }],
    };
    expect(mappedSharedCssRule(input)?.source).toEqual({
      path,
      line: 2,
      column: 3,
    });
    // Bundlers may add a sandbox prefix, but a basename by itself is not a
    // reference to the checked-in source path.
    expect(
      mappedSharedCssRule({
        ...input,
        mapped: { ...mapped, path: `/sandbox/source/${path}` },
      })?.source.path,
    ).toBe(path);
    expect(
      mappedSharedCssRule({
        ...input,
        mapped: {
          ...mapped,
          path: "packages/design-systems/core/misleading.css",
        },
      }),
    ).toBeUndefined();
    expect(
      mappedSharedCssRule({
        ...input,
        mapped: { ...mapped, path: "card.css" },
      }),
    ).toBeUndefined();
    expect(
      mappedSharedCssRule({
        ...input,
        map: { ...map, sourcesContent: [".card { color: red; }"] },
      }),
    ).toBeUndefined();
    // A utility map that lands on the root rather than an authored declaration
    // cannot claim shared provenance.
    expect(
      mappedSharedCssRule({
        ...input,
        mapped: { ...mapped, line: 1, column: 1 },
      }),
    ).toBeUndefined();
    expect(
      mappedSharedCssRule({ ...input, sharedCssRules: [...rules, rules[0]!] }),
    ).toBeUndefined();
  });
  it("escapes untrusted model/page copy in reports", () => {
    expect(escapeHtml('<script>"&')).toBe("&lt;script&gt;&quot;&amp;");
    expect(
      renderReport({
        createdAt: "now",
        source: { value: "<script>" },
        judge: {},
        captures: [],
      }),
    ).not.toContain("<script>");
  });
});
