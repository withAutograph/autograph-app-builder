import { describe, expect, it } from "vitest";
import { collectCssRuleEvidence, generatedCssRule } from "./css-evidence";

describe("CSS rule evidence", () => {
  const generated = collectCssRuleEvidence([
    {
      path: "src/screen.css",
      content: ".screen { color: var(--color-text-primary); }",
    },
  ]);

  it("attributes an exact active rule despite compiler declaration reordering", () => {
    const rule = generatedCssRule(
      generated,
      [],
      ".screen",
      "color",
      "var(--color-text-primary)",
      [{ name: "color", value: "var(--color-text-primary)" }],
    );
    expect(rule?.source).toMatchObject({ path: "src/screen.css", line: 1 });
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
        ],
      ),
    ).toBeUndefined();
  });

  it("keeps copied, ambiguous, and absent source evidence unassigned", () => {
    const shared = collectCssRuleEvidence([
      {
        path: "packages/design-systems/shared.css",
        content: ".screen { color: var(--color-text-primary); }",
      },
    ]);
    expect(
      generatedCssRule(
        generated,
        [],
        ".screen",
        "color",
        "#292929",
        [{ name: "color", value: "#292929" }],
      ),
    ).toBeUndefined();
    expect(
      generatedCssRule(
        generated,
        shared,
        ".screen",
        "color",
        "var(--color-text-primary)",
        [{ name: "color", value: "var(--color-text-primary)" }],
      ),
    ).toBeUndefined();
  });

  it("preserves quoted string whitespace and leaves conditional source unknown", () => {
    expect(
      generatedCssRule(
        collectCssRuleEvidence([
          {
            path: "src/conditional.css",
            content: "@media (min-width: 800px) { .screen { color: var(--color-text-primary); } }",
          },
        ]),
        [],
        ".screen",
        "color",
        "var(--color-text-primary)",
        [{ name: "color", value: "var(--color-text-primary)" }],
      ),
    ).toBeUndefined();
    const strings = collectCssRuleEvidence([
      {
        path: "src/strings.css",
        content: '.copy::before { content: "a b"; }',
      },
    ]);
    expect(
      generatedCssRule(
        strings,
        [],
        ".copy::before",
        "content",
        '"a  b"',
        [{ name: "content", value: '"a b"' }],
      ),
    ).toBeUndefined();
  });
});
