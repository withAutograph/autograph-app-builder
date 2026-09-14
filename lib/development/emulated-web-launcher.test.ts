import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

// oxlint-disable-next-line typescript/strict-void-return -- Adapt Node's overloaded callback API.
const execute = promisify(execFile);

it("hands explicit mise through the actual sanitized launcher to the shared task", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "emulated-launcher-"));
  try {
    const log = path.join(root, "pnpm-called");
    const pnpm = path.join(root, "pnpm");
    const mise = path.join(root, "mise");
    const script = path.join(root, "invoke.mjs");
    await writeFile(pnpm, `#!/bin/sh\nprintf '%s' "$*" > '${log}'\nexit 77\n`, { mode: 0o700 });
    await writeFile(
      mise,
      `#!/bin/sh\nif [ "$1" = which ] && [ "$2" = pnpm ]; then printf '%s' '${pnpm}'; else exit 78; fi\n`,
      { mode: 0o700 },
    );
    await writeFile(
      script,
      `import {spawnSync} from 'node:child_process';const r=spawnSync(${JSON.stringify(path.resolve(".config/mise/tasks/app/dev-emulated"))},[],{env:process.env,stdio:'inherit'});process.exit(r.status ?? 1);`,
    );
    const environment = { ...process.env };
    delete environment.NODE_OPTIONS;
    await expect(
      execute(
        path.resolve(".config/mise/scripts/trusted-node-launcher"),
        [process.execPath, script],
        { env: { ...environment, APP_BUILDER_DEV_MISE_BIN: mise } },
      ),
    ).rejects.toMatchObject({ code: 77 });
    expect(await readFile(log, "utf-8")).toContain(
      "scripts/prepare-emulate-config.mts https://localhost:3001",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
