export const forbiddenPublicVocabulary =
  /(?:\bAppSpec\b|specification acceptance|formal acceptance|artifact record(?:ing)?|\breceipts?\b|\bdigests?\b|\bworkspace(?:-preparation)?\b|isolated workspace|source (?:binding|contract|receipt|sha)|validation gate|protocol operation|opaque validator|\bvalidator\b|\bblocker\b)/iu;

// oxlint-disable-next-line eslint/func-style, anti-slop/no-unknown-parameters -- Preserve function declaration hoisting and initialization timing. Preserve the existing unknown input contract.
export function isProductFacing(message: unknown): boolean {
  return !forbiddenPublicVocabulary.test(String(message));
}
