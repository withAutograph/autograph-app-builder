import { describe, expect, it } from "vitest";

import { collectCssRuleEvidence, generatedCssRule } from "./css-evidence";

describe("CSS rule evidence", () => {
  const generated = collectCssRuleEvidence([
    {
      content: ".screen { color: var(--color-text-primary); }",
      path: "src/screen.css",
    },
  ]);

  it("attributes an exact active rule despite compiler declaration reordering", () => {
    const rule = generatedCssRule(
      generated,
      [],
      ".screen",
      "color",
      "var(--color-text-primary)",
      [{ name: "color", value: "var(--color-text-primary)" }]
    );
    expect(rule?.source).toMatchObject({ line: 1, path: "src/screen.css" });
  });

  it("rejects synthetic shorthand expansion unless the caller removes it", () => {
    expect(
      generatedCssRule(
        generated,
        [],
        ".screen",
        "color",
        "var(--color-text-primary)",
        [
          { name: "color", value: "var(--color-text-primary)" },
          { name: "color", value: "var(--color-text-primary)" },
        ]
      )
    ).toBeUndefined();
  });

  it("keeps copied, ambiguous, and absent source evidence unassigned", () => {
    const shared = collectCssRuleEvidence([
      {
        content: ".screen { color: var(--color-text-primary); }",
        path: "packages/design-systems/shared.css",
      },
    ]);
    expect(
      generatedCssRule(generated, [], ".screen", "color", "#292929", [
        { name: "color", value: "#292929" },
      ])
    ).toBeUndefined();
    expect(
      generatedCssRule(
        generated,
        shared,
        ".screen",
        "color",
        "var(--color-text-primary)",
        [{ name: "color", value: "var(--color-text-primary)" }]
      )
    ).toBeUndefined();
  });

  it("preserves quoted string whitespace and leaves conditional source unknown", () => {
    expect(
      generatedCssRule(
        collectCssRuleEvidence([
          {
            content:
              "@media (min-width: 800px) { .screen { color: var(--color-text-primary); } }",
            path: "src/conditional.css",
          },
        ]),
        [],
        ".screen",
        "color",
        "var(--color-text-primary)",
        [{ name: "color", value: "var(--color-text-primary)" }]
      )
    ).toBeUndefined();
    const strings = collectCssRuleEvidence([
      {
        content: '.copy::before { content: "a b"; }',
        path: "src/strings.css",
      },
    ]);
    expect(
      generatedCssRule(strings, [], ".copy::before", "content", '"a  b"', [
        { name: "content", value: '"a b"' },
      ])
    ).toBeUndefined();
  });
});
