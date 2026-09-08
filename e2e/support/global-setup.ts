import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { encryptOverrides } from "flags";
import type { FullConfig } from "playwright/test";

const flagsStorageState = "test-results/passkey-flags-storage-state.json";

export default async function globalSetup(config: FullConfig) {
  const projectRoot = config.configFile
    ? dirname(config.configFile)
    : process.cwd();
  const secret = (
    await readFile(resolve(projectRoot, ".emulate/flags-secret"), "utf8")
  ).trim();
  const override = await encryptOverrides({ passkeys: true }, secret, "1h");
  const storageStatePath = resolve(projectRoot, flagsStorageState);

  await mkdir(dirname(storageStatePath), { recursive: true });
  await writeFile(
    storageStatePath,
    JSON.stringify({
      cookies: [
        {
          name: "vercel-flag-overrides",
          value: override,
          domain: "localhost",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ],
      origins: [],
    }),
    { mode: 0o600 },
  );
}
