import { isAbsolute } from "node:path";

export function safeSourcePath(path: string): boolean {
  return (
    path !== "" &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !/[\r\n]/u.test(path) &&
    !path.split("/").some((segment) => segment === "." || segment === "..")
  );
}
