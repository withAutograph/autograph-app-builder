import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";

import { providerEmulationSeed } from "../lib/integrations/provider-emulation-seed";

const stateDirectory = path.join(process.cwd(), ".emulate");
const keyPath = path.join(stateDirectory, "github-app-private-key.pem");
const configPath = path.join(stateDirectory, "config.yaml");
const relayPath = path.join(stateDirectory, "relay-secret");
const authSecretPath = path.join(stateDirectory, "better-auth-secret");
const flagsSecretPath = path.join(stateDirectory, "flags-secret");

const origin = process.argv[2];
if (!origin) {
  throw new Error("Expected the local application origin.");
}
const appOrigin = new URL(origin);
const ciLoopback = process.env.CI === "true" && appOrigin.protocol === "http:";
if (
  appOrigin.hostname !== "localhost" ||
  (appOrigin.protocol !== "https:" && !ciLoopback)
) {
  throw new Error("The local application origin must be https://localhost.");
}

await mkdir(stateDirectory, { recursive: true });
let privateKey: string;
try {
  privateKey = await readFile(keyPath, "utf-8");
} catch {
  privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ format: "pem", type: "pkcs1" })
    .toString();
  await writeFile(keyPath, privateKey, { mode: 0o600 });
}
try {
  await readFile(relayPath, "utf-8");
} catch {
  await writeFile(relayPath, randomBytes(32).toString("base64url"), {
    mode: 0o600,
  });
}
try {
  await readFile(flagsSecretPath, "utf-8");
} catch {
  await writeFile(flagsSecretPath, randomBytes(32).toString("base64url"), {
    mode: 0o600,
  });
}
let authSecret: string;
try {
  authSecret = (await readFile(authSecretPath, "utf-8")).trim();
} catch {
  authSecret = randomBytes(32).toString("base64url");
  await writeFile(authSecretPath, authSecret, { mode: 0o600 });
}
const config = providerEmulationSeed({
  githubAppPrivateKey: privateKey,
  githubClientId: "Iv1_local_app_client",
  githubClientSecret: "local-github-client-secret-value",
  origin: appOrigin.origin,
  strictGitHubOAuth: true,
  vercelClientId: "local-vercel-client",
  vercelClientSecret: "local-vercel-client-secret",
});
await writeFile(configPath, YAML.stringify(config), { mode: 0o600 });
