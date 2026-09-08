import { describe, expect, it } from "vitest";

import { analyzeSource, parseTokens } from "./source";

const tokenCss = `
  @theme {
    --color-canvas: #fafafa;
    --color-bg-page: var(--color-canvas);
    --space-4: 16px;
  }
`;

describe("parseTokens", () => {
  it("resolves declared custom-property aliases", () => {
    expect(parseTokens(tokenCss)).toEqual({
      "--color-bg-page": "#fafafa",
      "--color-canvas": "#fafafa",
      "--space-4": "16px",
    });
  });
});

describe("analyzeSource", () => {
  it("reports JSX imports, token evidence, and literal classifications", () => {
    const report = analyzeSource({
      tokenCss,
      files: [{
        path: "app/page.tsx",
        content: `
          import { Card, Unused } from "./ui";
          import Logo from "./logo";
          export function Page() {
            return <Card style={{ color: "var(--color-bg-page)", padding: "16px", width: "100%", display: "grid", margin: "0" }} className="bg-[#fafafa] p-[12px]"><Logo /></Card>;
          }
        `,
      }],
    });

    expect(report.imports).toEqual([{ path: "app/page.tsx", names: ["Card", "Logo"] }]);
    expect(report.semanticVarRefs).toEqual(["--color-bg-page"]);
    expect(report.undefinedTokens).toEqual([]);
    expect(report.generatedLiterals).toEqual(["#fafafa", "12px", "16px"]);
    expect(report.matchingLiterals).toEqual(["#fafafa", "16px"]);
    expect(report.unknownLiterals).toEqual(["12px"]);
  });

  it("keeps missing token references as evidence", () => {
    const report = analyzeSource({
      tokenCss,
      files: [{ path: "app/page.tsx", content: `<main style={{ color: "var(--missing)" }} />` }],
    });
    expect(report.tokenRefs).toEqual(["--missing"]);
    expect(report.undefinedTokens).toEqual(["--missing"]);
  });
});
