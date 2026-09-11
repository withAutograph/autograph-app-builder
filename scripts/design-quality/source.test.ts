import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { analyzeSource, parseTokens } from "./source";
import type { Reference } from "./reference";

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

  it("reads adjacent declarations and real core-theme aliases", () => {
    expect(parseTokens(`/* first */ @theme { --one: #fff; --two: var(--one); }`)).toEqual({
      "--one": "#fff",
      "--two": "#fff",
    });
    const coreTheme = `@theme { /* value */ --color-canvas: #fafaf9;
      --color-bg-page: var(--color-canvas); --color-blue-500: #8192ff;
      --color-action-primary: var(--color-blue-500); }`;
    const tokens = parseTokens(coreTheme);
    expect(tokens["--color-bg-page"]).toBe(tokens["--color-canvas"]);
    expect(tokens["--color-action-primary"]).toBe(tokens["--color-blue-500"]);
  });
});

describe("analyzeSource", () => {
  const reference: Reference = {
    limitations: [],
    modules: {
      "@autograph/components": {
        exports: {
          Button: {
            props: {
              variant: { required: false, values: ["primary", "secondary"] },
              label: { required: false, primitiveKinds: ["string"] },
            },
          },
        },
      },
    },
  };

  it("uses selected public types, skips false branches, and labels unknown paths", () => {
    const report = analyzeSource({
      tokenCss,
      reference,
      files: [
        {
          path: "app/page.tsx",
          content: `
        import { Button } from "@autograph/components";
        export function Page() { return <>{false ? <button /> : null}{ready ? <Button variant="other" {...props} /> : null}</>; }
      `,
        },
      ],
    });
    expect(report.observations.some((o) => o.classification === "local-control")).toBe(false);
    expect(report.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimension: "api",
          verdict: "nonconforming",
          classification: "prop",
        }),
        expect.objectContaining({
          dimension: "api",
          verdict: "unassessed",
          classification: "spread-props",
        }),
        expect.objectContaining({
          dimension: "component",
          verdict: "unassessed",
          classification: "dynamic-reachability",
        }),
      ]),
    );
  });

  it("does not score dead branches or unresolved imports as local replacements", () => {
    const report = analyzeSource({
      tokenCss,
      reference,
      files: [
        {
          path: "app/page.tsx",
          content: `
        import { Button } from "@autograph/components";
        import { FancyControl } from "some-library";
        function LocalControl() { return <button />; }
        export function Page() { return <>{false && <Button variant="other" />}{true && <FancyControl />}</>; }
      `,
        },
      ],
    });
    expect(report.observations.some((o) => o.summary.includes("outside the public variants"))).toBe(
      false,
    );
    expect(report.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          classification: "unresolved-component",
          verdict: "unassessed",
        }),
      ]),
    );
    expect(report.observations.some((o) => o.summary.includes("Local custom visual control"))).toBe(
      false,
    );
  });

  it("reports public component color overrides and excludes responsive dimensions", () => {
    const report = analyzeSource({
      tokenCss,
      reference,
      files: [
        {
          path: "app/page.tsx",
          content: `
        import { Button } from "@autograph/components";
        export function Page() { return <Button style={{ color: "var(--color-bg-page)", maxWidth: "320px", gridTemplateColumns: "1fr 2fr" }} />; }
      `,
        },
      ],
    });
    expect(report.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          classification: "token-reference",
          verdict: "nonconforming",
          summary: expect.stringContaining("color treatment override"),
        }),
      ]),
    );
    expect(report.observations.some((o) => o.summary.includes("320px"))).toBe(false);
  });

  it("credits only TypeScript-proven static primitive prop values", () => {
    const report = analyzeSource({
      tokenCss,
      reference,
      files: [
        {
          path: "app/page.tsx",
          content: `
        import { Button } from "@autograph/components";
        export function Page() { const data = "x"; return <><Button label="OK" /><Button label={2} /><Button label={data} /></>; }
      `,
        },
      ],
    });
    const labels = report.observations.filter(
      (o) => o.dimension === "api" && o.classification === "prop" && o.summary.includes("label"),
    );
    expect(labels.map((o) => o.verdict).sort()).toEqual([
      "conforming",
      "nonconforming",
      "unassessed",
    ]);
  });

  it("uses selected Arrusted types for nested object props", async () => {
    const root = await mkdtemp(join(tmpdir(), "arrusted-types-"));
    await mkdir(join(root, "core"), { recursive: true });
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          paths: { "@autograph/compositions": ["./core/compositions.tsx"] },
        },
      }),
    );
    await writeFile(
      join(root, "core", "compositions.tsx"),
      `export function DataTable(_props: { spec: { narrowLayout: "compact" | "full" } }) { return null; }`,
    );
    const report = analyzeSource({
      tokenCss,
      reference: {
        arrustedRoot: root,
        limitations: [],
        modules: {
          "@autograph/compositions": {
            exports: { DataTable: { props: { spec: { required: true } } } },
          },
        },
      },
      files: [
        {
          path: "app/page.tsx",
          content: `import { DataTable } from "@autograph/compositions"; export function Page() { return <DataTable spec={{ narrowLayout: "wide" }} />; }`,
        },
      ],
    });
    expect(report.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimension: "api",
          verdict: "nonconforming",
          classification: "prop",
        }),
      ]),
    );
  });

  it("reports JSX imports, token evidence, and literal classifications", () => {
    const report = analyzeSource({
      tokenCss,
      files: [
        {
          path: "app/page.tsx",
          content: `
          import { Card as Surface, Unused } from "@autograph/components";
          import * as Icons from "@autograph/icons";
          import Logo from "./logo";
          export function Page() {
            return <Surface style={{ color: "var(--color-bg-page)", padding: "16px", width: "100%", display: "grid", margin: "0px" }} className="bg-[#fafafa] p-[12px]"><Icons.Check /><Logo /></Surface>;
          }
        `,
        },
      ],
    });

    expect(report.imports).toEqual([
      {
        path: "app/page.tsx",
        source: "@autograph/components",
        name: "Card",
        localName: "Surface",
      },
      {
        path: "app/page.tsx",
        source: "@autograph/icons",
        name: "*",
        localName: "Icons",
      },
    ]);
    expect(report.semanticVarRefs).toEqual(["--color-bg-page"]);
    expect(report.undefinedTokens).toEqual([]);
    expect(report.generatedLiterals).toEqual(["#fafafa", "12px", "16px"]);
    expect(report.matchingLiterals).toEqual(["#fafafa", "16px"]);
    expect(report.unknownLiterals).toEqual(["12px"]);
  });

  it("keeps missing token references as evidence", () => {
    const report = analyzeSource({
      tokenCss,
      files: [
        {
          path: "app/page.tsx",
          content: `<main style={{ color: "var(--missing)" }} />`,
        },
      ],
    });
    expect(report.tokenRefs).toEqual(["--missing"]);
    expect(report.undefinedTokens).toEqual(["--missing"]);
  });

  it("analyzes CSS declaration values and exempts structural values", () => {
    const report = analyzeSource({
      tokenCss,
      files: [
        {
          path: "app/styles.css",
          content: `.panel { color: var(--color-bg-page); padding: 16px; margin: 0px; width: 100%; display: grid; border-color: #123456; }`,
        },
      ],
    });
    expect(report.semanticVarRefs).toEqual(["--color-bg-page"]);
    expect(report.matchingLiterals).toEqual(["16px"]);
    expect(report.unknownLiterals).toEqual(["#123456"]);
  });
});
