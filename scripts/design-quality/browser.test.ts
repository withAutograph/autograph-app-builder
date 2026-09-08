import { describe, expect, it } from "vitest";
import {
  arrustedSharedSource,
  classifyStyle,
  generatedSource,
  scenariosSchema,
  sourcePath,
} from "./browser";
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
