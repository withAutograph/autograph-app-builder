import { describe, expect, it } from "vitest";
import {
  collectIntrinsicClassSignatures,
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
    expect(generatedSignatureSelector(candidate, ".generated-card:hover")).toBe(
      false,
    );
    expect(
      uniqueIntrinsicSignature(generated, "div", [
        "generated-card",
        "tokenized",
      ]),
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
      signatureAttribution(generated, undefined, "section", [
        "generated-card",
        "tokenized",
      ]).provenance,
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
      signatureAttribution(generated, shared, "section", [
        "generated-card",
        "tokenized",
      ]).provenance,
    ).toBe("unknown");
  });
});
