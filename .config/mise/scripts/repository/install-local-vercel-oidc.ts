import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";

import {
  parseLinkedVercelProject,
  parseLocalVercelOidcToken,
  readOwnerBoundLocalFile,
  validateLocalVercelOidcClaims,
} from "../../../../lib/eve/local-vercel-oidc";

const repositoryRoot = resolve(import.meta.dirname, "../../../../");
if (process.cwd() !== repositoryRoot || process.argv.length !== 2) {
  throw new Error("The local OIDC installer invocation was invalid.");
}

const environmentPath = resolve(repositoryRoot, ".env.local");
const projectPath = resolve(repositoryRoot, ".vercel/project.json");
const environment = readOwnerBoundLocalFile(environmentPath, {
  confidential: false,
});
const project = parseLinkedVercelProject(
  readOwnerBoundLocalFile(projectPath, { confidential: false }),
);
const token = parseLocalVercelOidcToken(environment);
const claims = validateLocalVercelOidcClaims({
  token,
  project,
  nowEpochSeconds: Math.floor(Date.now() / 1000),
});

const temporaryPath = resolve(
  dirname(environmentPath),
  `.env.local.install-${randomBytes(12).toString("hex")}`,
);
let temporaryExists = false;
try {
  const descriptor = openSync(temporaryPath, "wx", 0o600);
  temporaryExists = true;
  try {
    writeFileSync(descriptor, environment, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, environmentPath);
  temporaryExists = false;
  const directory = openSync(dirname(environmentPath), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
} finally {
  if (temporaryExists) unlinkSync(temporaryPath);
}

process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    installed: ".env.local",
    mode: "0600",
    claims,
  })}\n`,
);
