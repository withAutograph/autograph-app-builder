export const forbiddenPublicVocabulary =
  /(?:\bAppSpec\b|specification acceptance|formal acceptance|artifact record(?:ing)?|\breceipts?\b|\bdigests?\b|\bworkspace(?:-preparation)?\b|isolated workspace|source (?:binding|contract|receipt|sha)|validation gate|protocol operation|opaque validator|\bvalidator\b|\bblocker\b)/iu;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function isProductFacing(message: unknown): boolean {
  return !forbiddenPublicVocabulary.test(String(message));
}
