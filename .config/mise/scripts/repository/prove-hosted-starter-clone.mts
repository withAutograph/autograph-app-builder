import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import {
  acquireCanonicalArrustedTemplate,
  inspectCanonicalArrustedSandboxWorkspace,
} from "../../../../lib/repository/arrusted-template";
import {
  parseLinkedVercelProject,
  parseLocalVercelOidcToken,
  readOwnerBoundLocalFile,
  validateLocalVercelOidcToken,
} from "../../../../lib/eve/local-vercel-oidc";
import { createHostedVercelBackend } from "../../../../lib/sandbox/vercel-backend";

const repositoryRoot = resolve(import.meta.dirname, "../../../../");
if (
  process.argv.length !== 2 ||
  process.cwd() !== repositoryRoot ||
  realpathSync(process.cwd()) !== repositoryRoot
)
  throw new Error("The hosted starter clone proof invocation was invalid.");

const requiredEnvironmentKeys = [
  "APP_BUILDER_TEMPLATE_READER_INSTALLATION_ID",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
] as const;

function parseQuotedEnvironmentValue(source: string, name: string): string {
  const matches = source
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(`${name}=`));
  if (matches.length !== 1)
    throw new Error(`The Development environment is missing ${name}.`);
  const encoded = matches[0]!.slice(name.length + 1);
  let value: unknown;
  try {
    value = encoded.startsWith('"') ? JSON.parse(encoded) : encoded;
  } catch {
    throw new Error(`The Development environment contains invalid ${name}.`);
  }
  if (typeof value !== "string" || value.length === 0 || value.length > 32_768)
    throw new Error(`The Development environment contains invalid ${name}.`);
  return value;
}

const linkedProject = parseLinkedVercelProject(
  readOwnerBoundLocalFile(resolve(repositoryRoot, ".vercel/project.json"), {
    confidential: false,
  }),
);
const localEnvironment = readOwnerBoundLocalFile(
  resolve(repositoryRoot, ".env.local"),
  { confidential: true },
);
const token = validateLocalVercelOidcToken({
  token: parseLocalVercelOidcToken(localEnvironment),
  project: linkedProject,
  nowEpochSeconds: Math.floor(Date.now() / 1_000),
});

if (
  Object.hasOwn(process.env, "VERCEL_TOKEN") ||
  Object.hasOwn(process.env, "AI_GATEWAY_API_KEY")
)
  throw new Error("Static provider credentials are unsupported.");

process.env.VERCEL_OIDC_TOKEN = token;
for (const key of requiredEnvironmentKeys)
  process.env[key] = parseQuotedEnvironmentValue(localEnvironment, key);

const backend = createHostedVercelBackend({
  runtimeRecoveryPrewarmInput: () => ({
    bootstrap: async ({ use }) => {
      // eslint-disable-next-line react-hooks/rules-of-hooks -- Eve lifecycle callback, not a React hook.
      await use();
    },
    seedFiles: [],
  }),
});
const sessionKey = `starter-clone-prove-${randomUUID()}`;
let handle: Awaited<ReturnType<typeof backend.create>> | undefined;

try {
  handle = await backend.create({
    runtimeContext: { appRoot: repositoryRoot },
    sessionKey,
    templateKey: null,
  });
  const receipt = await acquireCanonicalArrustedTemplate({
    sandbox: handle.session,
    callId: sessionKey,
  });
  if (receipt.version !== 4)
    throw new Error("The canonical starter did not produce a cloned receipt.");
  const workspace = await inspectCanonicalArrustedSandboxWorkspace({
    sandbox: handle.session,
    receipt,
  });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      provider: "vercel-sandbox",
      project: linkedProject.projectName,
      sourceSha: receipt.sourceSha,
      sourceTree: receipt.sourceTree,
      eligibilityDigest: receipt.eligibilityDigest,
      contractDigest: receipt.contractDigest,
      workspaceDigest: workspace.workspaceDigest,
    })}\n`,
  );
} finally {
  try {
    await handle?.shutdown();
  } finally {
    delete process.env.VERCEL_OIDC_TOKEN;
    for (const key of requiredEnvironmentKeys) delete process.env[key];
  }
}
