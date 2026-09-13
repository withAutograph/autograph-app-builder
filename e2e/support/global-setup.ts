import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { encryptOverrides } from "flags";
import type { FullConfig } from "playwright/test";

const flagsStorageState = "test-results/passkey-flags-storage-state.json";

export default async function globalSetup(config: FullConfig) {
  const projectRoot = config.configFile ? path.dirname(config.configFile) : process.cwd();
  const secretFile = await readFile(path.resolve(projectRoot, ".emulate/flags-secret"), "utf-8");
  const secret = secretFile.trim();
  const override = await encryptOverrides({ passkeys: true }, secret, "1h");
  const storageStatePath = path.resolve(projectRoot, flagsStorageState);

  await mkdir(path.dirname(storageStatePath), { recursive: true });
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
    { mode: 0o600 },
  );
}
