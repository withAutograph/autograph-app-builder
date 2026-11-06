export const forbiddenPublicVocabulary =
  /(?:\bAppSpec\b|specification acceptance|formal acceptance|artifact record(?:ing)?|\breceipts?\b|\bdigests?\b|\bworkspace(?:-preparation)?\b|isolated workspace|source (?:binding|contract|receipt|sha)|validation gate|protocol operation|opaque validator|\bvalidator\b|\bblocker\b)/iu;

export const isProductFacing = (message: string): boolean =>
  !forbiddenPublicVocabulary.test(message);
