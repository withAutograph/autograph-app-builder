import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it.each(["dev-emulated", "reset-emulated"])(
  "%s resolves Docker only for an owned database",
  async (task) => {
    const script = path.resolve(`.config/mise/tasks/app/${task}`);
    const root = await mkdtemp(path.join(tmpdir(), "external-db-shell-"));
    try {
      await mkdir(path.join(root, "bin"));
      await mkdir(path.join(root, ".emulate"));
      const mise = path.join(root, "bin/mise");
      await writeFile(
        mise,
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TRACE_FILE"\nif [ "$1" = which ]; then printf "/usr/bin/true\\n"; fi\n',
      );
      await chmod(mise, 0o700);
      const lsof = path.join(root, "bin/lsof");
      await writeFile(lsof, "#!/bin/sh\nexit 0\n");
      await chmod(lsof, 0o700);
      for (const external of ["1", "0"]) {
        const trace = path.join(root, `trace-${external}`);
        const execution = spawnSync("/bin/sh", [script], {
          cwd: root,
          env: {
            APP_BUILDER_EXTERNAL_DATABASE: external,
            PATH: `${path.join(root, "bin")}:/usr/bin:/bin`,
            TRACE_FILE: trace,
          },
          timeout: 5000,
        });
        expect(execution.error).toBeUndefined();
        // oxlint-disable-next-line eslint/no-await-in-loop -- Script variants share an isolated fixture and execute sequentially.
        const commands = await readFile(trace, "utf-8").catch(() => "");
        expect(commands.includes("which docker")).toBe(external === "0");
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  },
);
