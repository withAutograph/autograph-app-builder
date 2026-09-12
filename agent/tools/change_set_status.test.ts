import { describe, expect, it } from "vitest";

import { isCandidateExportTextPath } from "./change_set_status";

describe("reviewed candidate export", () => {
  it.each([
    "apps/replica/app/page.tsx",
    "apps/replica/package.json",
    "apps/replica/next.config.mjs",
    "apps/replica/Dockerfile",
    "apps/replica/.gitignore",
  ])("includes auditable text source %s", (path) => {
    expect(isCandidateExportTextPath(path)).toBe(true);
  });

  it.each(["apps/replica/hk.pkl", "apps/replica/public/logo.png", "apps/replica/font.woff2"])(
    "omits non-text artifact %s",
    (path) => {
      expect(isCandidateExportTextPath(path)).toBe(false);
    },
  );
});
