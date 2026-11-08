import nodePath from "node:path";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function safeSourcePath(path: string): boolean {
  if (path === "" || nodePath.isAbsolute(path)) {
    return false;
  }
  return (
    !path.includes("\\") &&
    !/[\r\n]/u.test(path) &&
    !path.split("/").some((segment) => segment === "." || segment === "..")
  );
}
