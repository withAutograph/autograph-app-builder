import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const commands = [
  {
    task: ".config/mise/tasks/dev",
    usage: "mise run dev -- --arrusted-root",
    boundary: "Development mode cannot publish, deploy, or mutate providers.",
  },
  {
    task: ".config/mise/tasks/release/prove",
    usage: "mise run release:prove --",
    boundary: "does not publish anything",
  },
  {
    task: ".config/mise/tasks/release/publish",
    usage: "mise run release:publish --",
    boundary: "Run it only after explicit publication authorization.",
  },
] as const;

describe("public command help", () => {
  for (const command of commands) {
    it(`documents ${command.task}`, () => {
      const result = spawnSync(resolve(command.task), ["--help"], {
        encoding: "utf8",
        env: { LANG: "C", NODE_ENV: "test", PATH: "/usr/bin:/bin" },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(command.usage);
      expect(result.stdout).toContain(command.boundary);
      expect(result.stdout).not.toContain("Error:");
    });
  }
});
