import { describe, expect, it } from "vitest";
import {
  collectIntrinsicClassSignatures,
  classTokenAttribution,
  collectClassTokenEvidence,
  escapedTailwindClassToken,
  generatedSignatureSelector,
  signatureAttribution,
  uniqueIntrinsicSignature,
} from "./class-evidence";

describe("intrinsic class evidence", () => {
  const generated = collectIntrinsicClassSignatures([
    {
      path: "src/Screen.tsx",
      content:
        'export function Screen(){ return <section className="generated-card tokenized">ok</section> }',
    },
  ]);

  it("requires the exact rendered intrinsic signature and an exact selector", () => {
    const candidate = uniqueIntrinsicSignature(generated, "section", [
      "generated-card",
      "tokenized",
    ]);
    expect(generatedSignatureSelector(candidate, ".generated-card")).toBe(true);
    expect(generatedSignatureSelector(candidate, ".generated-card:hover")).toBe(false);
    expect(
      uniqueIntrinsicSignature(generated, "div", ["generated-card", "tokenized"]),
    ).toBeUndefined();
  });

  it("ignores valueless and namespaced JSX attributes", () => {
    expect(
      collectIntrinsicClassSignatures([
        {
          path: "src/InvalidCandidates.tsx",
          content:
            'export function Invalid(){ return <><div className /><div svg:className="not-a-class" /></> }',
        },
      ]),
    ).toEqual([]);
  });

  it("keeps source-only and shared-collision signatures unknown", () => {
    expect(
      signatureAttribution(generated, undefined, "section", ["generated-card", "tokenized"])
        .provenance,
    ).toBe("unknown");
    const shared = collectIntrinsicClassSignatures([
      {
        path: "packages/design-systems/Card.tsx",
        content:
          'export function Card(){ return <section className="generated-card tokenized">shared</section> }',
      },
    ]);
    // The generated candidate is deliberately unrendered in this adversarial
    // case; an identical shared DOM signature must not gain generated credit.
    expect(
      signatureAttribution(generated, shared, "section", ["generated-card", "tokenized"])
        .provenance,
    ).toBe("unknown");
  });

  it("offers a uniquely escaped utility token only as an origin candidate", () => {
    const shared = collectClassTokenEvidence([
      {
        path: "packages/design-systems/RecordList.tsx",
        content:
          'export function RecordList(){ return <button className={cx("data-[selected=true]:shadow-[inset_3px_0_0_var(--color-action-primary)]", focusRing)}>Stock</button> }',
      },
    ]);
    const selector =
      '.data-\\[selected\\=true\\]\\:shadow-\\[inset_3px_0_0_var\\(--color-action-primary\\)\\][data-selected="true"]';
    expect(escapedTailwindClassToken(selector)).toBe(
      "data-[selected=true]:shadow-[inset_3px_0_0_var(--color-action-primary)]",
    );
    expect(escapedTailwindClassToken('.token[data-label="a]b"][data-x]')).toBe("token");
    for (const invalid of [
      ".token[data-x] .other",
      ".token[data-x]:hover",
      ".token[data-x],.other",
      ".token[data-x",
    ])
      expect(escapedTailwindClassToken(invalid)).toBeUndefined();
    expect(classTokenAttribution([], shared, selector)).toMatchObject({
      provenance: "shared",
      source: { path: "packages/design-systems/RecordList.tsx" },
    });
    expect(classTokenAttribution([], [...shared, { ...shared[0]! }], selector).provenance).toBe(
      "unknown",
    );
    expect(classTokenAttribution([], shared, ".item:hover").provenance).toBe("unknown");
  });
});
