import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

const stateDirectory = path.join(process.cwd(), ".emulate");
const keyPath = path.join(stateDirectory, "github-app-private-key.pem");
const configPath = path.join(stateDirectory, "config.yaml");
const relayPath = path.join(stateDirectory, "relay-secret");
const authSecretPath = path.join(stateDirectory, "better-auth-secret");

const origin = process.argv[2];
if (!origin) throw new Error("Expected the local application origin.");
const appOrigin = new URL(origin);
if (appOrigin.protocol !== "https:" || appOrigin.hostname !== "localhost") {
  throw new Error("The local application origin must be https://localhost.");
}

await mkdir(stateDirectory, { recursive: true });
let privateKey: string;
try {
  privateKey = await readFile(keyPath, "utf8");
} catch {
  privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs1", format: "pem" })
    .toString();
  await writeFile(keyPath, privateKey, { mode: 0o600 });
}
const config = YAML.parse(await readFile("emulate.config.yaml", "utf8"));
config.github.apps[0].private_key = privateKey;
try {
  await readFile(relayPath, "utf8");
} catch {
  await writeFile(relayPath, randomBytes(32).toString("base64url"), {
    mode: 0o600,
  });
}
let authSecret: string;
try {
  authSecret = (await readFile(authSecretPath, "utf8")).trim();
} catch {
  authSecret = randomBytes(32).toString("base64url");
  await writeFile(authSecretPath, authSecret, { mode: 0o600 });
}
config.vercel.integrations[0].redirect_uris = [
  `${appOrigin.origin}/local-connections/vercel/oauth-callback`,
  `${appOrigin.origin}/api/auth/callback/vercel`,
];
config.github.oauth_apps[0].redirect_uris = [
  `${appOrigin.origin}/github/installations/callback`,
  `${appOrigin.origin}/api/auth/callback/github`,
];
await writeFile(configPath, YAML.stringify(config), { mode: 0o600 });
