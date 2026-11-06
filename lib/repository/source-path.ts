import nodePath from "node:path";

export function safeSourcePath(path: string): boolean {
  if (path === "" || nodePath.isAbsolute(path) || path.includes("\\") || /[\r\n]/u.test(path)) {
    return false;
  }

  return !path.split("/").some((segment) => segment === "." || segment === "..");
}
