import { expect, it } from "vitest";
import { appDescriptionSchema } from "./app-description";
import { describedBrowserEntryPath } from "./browser-entry-path";

it("uses checked catalog paths and leaves ambiguity or invalid explicit choices unresolved", () => {
  const app = { routes: ["/workspace", "/workspace/:path*"] };
  expect(describedBrowserEntryPath(app)).toBe("/workspace");
  expect(describedBrowserEntryPath({ routes: ["/review", "/requests"] })).toBeNull();
  expect(describedBrowserEntryPath({ ...app, browserEntryPath: null })).toBeNull();
  expect(
    describedBrowserEntryPath({ ...app, browserEntryPath: "https://other.example" }),
  ).toBeNull();
  // A concrete dynamic selection is projected only after the source app:describe official matcher checked ownership.
  expect(describedBrowserEntryPath({ ...app, browserEntryPath: "/workspace/123" })).toBe(
    "/workspace/123",
  );
  for (const value of [
    "//other.example",
    "/../other",
    "/%2e/other",
    "/workspace?x=1",
    "/workspace\\other",
  ]) {
    expect(describedBrowserEntryPath({ ...app, browserEntryPath: value })).toBeNull();
  }
});
it("preserves nullable browser readiness while the normal app description remains usable", () => {
  const result = appDescriptionSchema.parse({
    app: {
      browserEntryPath: null,
      id: "example",
      routes: ["/one", "/two"],
      workspacePath: "apps/example",
    },
    backend: { kind: "static" },
    validation: { browser: null, check: { task: "check" }, test: null },
    version: 1,
  });
  expect(result.app.browserEntryPath).toBeNull();
  expect(result.backend.kind).toBe("static");
});
