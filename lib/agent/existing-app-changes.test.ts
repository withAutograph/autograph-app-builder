import { describe, expect, it } from "vitest";

import { existingAppChangesSchema } from "./existing-app-changes";

describe("existing app planning changes", () => {
  it.each([
    "app/[id]/page.tsx",
    "app/auth/[...view]/page.tsx",
    "app/[[...slug]]/page.tsx",
    "app/(finance)/page.tsx",
    "app/@modal/(.)details/page.tsx",
    "app/@modal/(..)list/page.tsx",
    "app/(finance)/it's $HOME/page.tsx",
  ])("accepts the literal application filename %s", (file) => {
    expect(
      existingAppChangesSchema.parse([{ content: "source", path: `apps/example/${file}` }]),
    ).toEqual([{ content: "source", path: `apps/example/${file}` }]);
  });
  it.each([
    "/apps/example/page.tsx",
    "../example/page.tsx",
    "apps/../page.tsx",
    "apps/./page.tsx",
    "apps//page.tsx",
    "apps/example/",
    "apps\\example\\page.tsx",
    "apps/example/\0page.tsx",
    "apps/example/\npage.tsx",
    "apps/example/\tpage.tsx",
    "apps/example/\u007Fpage.tsx",
  ])("rejects a noncanonical application filename %j", (path) => {
    expect(existingAppChangesSchema.safeParse([{ content: "source", path }]).success).toBe(false);
  });
  it("accepts more files and content than the former Builder schema ceilings", () => {
    const parsed = existingAppChangesSchema.parse(
      Array.from({ length: 40 }, (_, index) => ({
        content: "x".repeat(index === 0 ? 300 * 1024 : 1),
        path: `apps/example/file-${index}.ts`,
      })),
    );
    expect(parsed).toHaveLength(40);
    expect(parsed[0]?.content).toHaveLength(300 * 1024);
  });
  it("accepts explicit removals without interpreting empty content as deletion", () => {
    expect(
      existingAppChangesSchema.parse([
        { operation: "delete", path: "apps/example/server/demo.ts" },
        { content: "", operation: "upsert", path: "apps/example/server/context.ts" },
      ]),
    ).toEqual([
      { operation: "delete", path: "apps/example/server/demo.ts" },
      { content: "", operation: "upsert", path: "apps/example/server/context.ts" },
    ]);
    expect(
      existingAppChangesSchema.safeParse([
        { content: "ambiguous", operation: "delete", path: "apps/example/server/demo.ts" },
      ]).success,
    ).toBe(false);
  });
});
