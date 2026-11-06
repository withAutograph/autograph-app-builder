import type { Adapter } from "flags";

/**
 * Storybook receives resolved feature-flag values through `viteFinal`, so its
 * browser bundle must not initialize Vercel's server-only flags transport.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createVercelAdapter() {
  return <ValueType, EntitiesType>(): Adapter<ValueType, EntitiesType> => ({
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test callback
    async decide({ defaultValue }) {
      return defaultValue as ValueType;
    },
  });
}
