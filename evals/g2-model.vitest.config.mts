/* oxlint-disable github/filenames-match-regex -- Preserve the documented Vitest configuration invocation path. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    maxWorkers: 1,
    pool: "threads",
  },
});
