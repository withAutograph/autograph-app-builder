import { describe, expect, it } from "vitest";

import { existingAppChangesSchema } from "./existing-app-changes";

describe("existing app planning changes", () => {
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
});
