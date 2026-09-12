import { isAbsolute } from "node:path";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function safeSourcePath(path: string): boolean {
  return (
    path !== "" &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !/[\r\n]/u.test(path) &&
    !path.split("/").some((segment) => segment === "." || segment === "..")
  );
}
