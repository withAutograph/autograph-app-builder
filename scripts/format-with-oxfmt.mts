import { format } from "oxfmt";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function formatWithOxfmt(path: string, source: string) {
  const result = await format(path, source);
  if (result.errors.length > 0) {
    throw new Error(
      `oxfmt could not format ${path}: ${result.errors.map((error) => error.message).join(", ")}`,
    );
  }

  return result.code;
}
