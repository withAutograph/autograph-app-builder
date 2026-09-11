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
    await readFile(resolve(projectRoot, ".emulate/flags-secret"), "utf-8")
  ).trim();
  const override = await encryptOverrides({ passkeys: true }, secret, "1h");
  const storageStatePath = resolve(projectRoot, flagsStorageState);

  await mkdir(dirname(storageStatePath), { recursive: true });
  await writeFile(
    storageStatePath,
    JSON.stringify({
      cookies: [
        {
          domain: "localhost",
          expires: -1,
          httpOnly: true,
          name: "vercel-flag-overrides",
          path: "/",
          sameSite: "Lax",
          secure: true,
          value: override,
        },
      ],
      origins: [],
    }),
    { mode: 0o600 }
  );
}
