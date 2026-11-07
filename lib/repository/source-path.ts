import nodePath from "node:path";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function safeSourcePath(path: string): boolean {
  if (path === "" || nodePath.isAbsolute(path) || path.includes("\\")) {
    return false;
  }

  if (/[\r\n]/u.test(path)) {
    return false;
  }

  return !path.split("/").some((segment) => segment === "." || segment === "..");
}
