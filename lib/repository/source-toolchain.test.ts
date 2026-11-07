import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sourceDeclaredToolchainActivationCommand } from "./source-toolchain";

describe("repository-declared tool activation", () => {
  it.each([0, 13])("preserves mise failure %s before running application setup", (exitCode) => {
    const root = mkdtempSync(path.join(tmpdir(), "builder-source-toolchain-"));
    try {
      const bin = path.join(root, "bin");
      mkdirSync(bin);
      mkdirSync(path.join(root, ".config/mise"), { recursive: true });
      const config = path.join(root, ".config/mise/config.toml");
      const source = '[tools]\nrust = { version = "1.97.1", components = "clippy,rustfmt" }\n';
      writeFileSync(config, source);
      writeFileSync(path.join(bin, "bun"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      writeFileSync(path.join(root, "cue"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      writeFileSync(
        path.join(bin, "mise"),
        `#!/bin/sh
printf '%s\\n' "$*" >> "$PWD/calls"
case "$1" in
 install) exit ${exitCode} ;;
 which) printf '%s\\n' "$PWD/cue" ;;
esac
`,
        { mode: 0o700 },
      );
      const result = spawnSync(
        "/bin/bash",
        ["-c", `${sourceDeclaredToolchainActivationCommand()}\nprintf 'runtime' > runtime-ran`],
        {
          cwd: root,
          encoding: "utf-8",
          env: { NODE_ENV: "test", PATH: `${bin}:/usr/bin:/bin` },
        },
      );
      expect(result.status, result.stderr).toBe(exitCode);
      expect(readFileSync(path.join(root, "calls"), "utf-8")).toContain(
        "install --locked cue rust\n",
      );
      expect(readFileSync(config, "utf-8")).toBe(source);
      expect(existsSync(path.join(root, "runtime-ran"))).toBe(exitCode === 0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
