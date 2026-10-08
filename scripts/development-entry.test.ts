import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(".");

describe("trusted local development entrypoint environment", () => {
  it("forwards the Vercel executable binding through the trusted Node launcher", () => {
    const pinnedNode = path.join(
      homedir(),
      ".local/share/mise/installs/node/24.18.0/bin/node",
    );
    const stateRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "builder-entrypoint-state-")));
    try {
      const result = spawnSync(
        path.join(repositoryRoot, ".config/mise/scripts/trusted-node-launcher"),
        [
          pinnedNode,
          "--import",
          "tsx",
          "scripts/development-entry.mts",
          "--arrusted-root",
          path.join(stateRoot, "missing-arrusted-root"),
          "--state-root",
          path.join(stateRoot, "state"),
        ],
        {
          cwd: repositoryRoot,
          encoding: "utf-8",
          env: {
            APP_BUILDER_DEV_NODE_BIN: pinnedNode,
            APP_BUILDER_DEV_VERCEL_BIN: "/mise/bin/vercel",
            HOME: homedir(),
            LANG: "C",
            LC_ALL: "C",
            PATH: `${path.dirname(pinnedNode)}:/usr/bin:/bin`,
            TMPDIR: tmpdir(),
            TZ: "UTC",
          },
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).not.toContain("APP_BUILDER_DEV_VERCEL_BIN");
      expect(result.stderr).toContain("missing-arrusted-root");
    } finally {
      rmSync(stateRoot, { force: true, recursive: true });
    }
  });
});
