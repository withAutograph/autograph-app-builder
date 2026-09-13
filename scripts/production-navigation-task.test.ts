import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("resolves task tools through absolute mise when PATH cannot find mise", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "navigation-task-"));
  const mise = path.join(directory, "mise-executable");
  const log = path.join(directory, "calls");
  try {
    mkdirSync(path.join(directory, ".config/mise/scripts"), { recursive: true });
    writeFileSync(
      mise,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$MISE_TEST_LOG"
printf '/usr/bin/true\\n'
`,
      { mode: 0o700 },
    );
    writeFileSync(
      path.join(directory, ".config/mise/scripts/trusted-node-launcher"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$MISE_TEST_LOG"
`,
      { mode: 0o700 },
    );
    const result = spawnSync(
      "/bin/sh",
      [
        path.resolve(import.meta.dirname, "../.config/mise/tasks/test/production-navigation"),
        "--json-report",
        "/tmp/navigation.json",
      ],
      {
        cwd: directory,
        encoding: "utf-8",
        env: { MISE_BIN_PATH: mise, MISE_TEST_LOG: log, PATH: "/usr/bin:/bin" },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(log, "utf-8");
    expect(calls).toContain("which docker");
    expect(calls).toContain("which node");
    expect(calls).toContain("--json-report /tmp/navigation.json");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
