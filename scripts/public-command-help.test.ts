import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const commands = [
  {
    task: ".config/mise/tasks/dev",
    usage: "mise run dev -- --arrusted-root",
  },
  {
    task: ".config/mise/tasks/release/prove",
    usage: "mise run release:prove --",
  },
  {
    task: ".config/mise/tasks/release/publish",
    usage: "mise run release:publish --",
  },
] as const;

describe("public command help", () => {
  for (const command of commands) {
    it(`documents ${command.task}`, () => {
      const result = spawnSync(path.resolve(command.task), ["--help"], {
        encoding: "utf-8",
        env: { LANG: "C", NODE_ENV: "test", PATH: "/usr/bin:/bin" },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(command.usage);
      expect(result.stdout).not.toContain("Error:");
    });
  }
});
