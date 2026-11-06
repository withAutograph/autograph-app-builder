import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import type { SandboxProviderSessionContext } from "eve/sandbox/provider";
import path from "node:path";

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
import { createBuilderVercelProvider } from "../../../../lib/sandbox/vercel-backend";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../../");
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

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function parseQuotedEnvironmentValue(source: string, name: string): string {
  const matches = source.split(/\r?\n/u).filter((line) => line.startsWith(`${name}=`));
  const [match] = matches;
  if (matches.length !== 1 || match === undefined)
    throw new Error(`The Development environment is missing ${name}.`);
  const encoded = match.slice(name.length + 1);
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
  readOwnerBoundLocalFile(path.resolve(repositoryRoot, ".vercel/project.json"), {
    confidential: false,
  }),
);
const localEnvironment = readOwnerBoundLocalFile(path.resolve(repositoryRoot, ".env.local"), {
  confidential: true,
});
const token = validateLocalVercelOidcToken({
  nowEpochSeconds: Math.floor(Date.now() / 1000),
  project: linkedProject,
  token: parseLocalVercelOidcToken(localEnvironment),
});

if (Object.hasOwn(process.env, "VERCEL_TOKEN") || Object.hasOwn(process.env, "AI_GATEWAY_API_KEY"))
  throw new Error("Static provider credentials are unsupported.");

process.env.VERCEL_OIDC_TOKEN = token;
for (const key of requiredEnvironmentKeys)
  process.env[key] = parseQuotedEnvironmentValue(localEnvironment, key);

const provider = createBuilderVercelProvider();
const sessionKey = `starter-clone-prove-${randomUUID()}`;
const context: SandboxProviderSessionContext = {
  host: {
    loadOptionalPackage: async ({ importModule }) => await importModule(),
    resolveProjectPath: (filePath) => path.resolve(repositoryRoot, filePath),
  },
  session: {
    auth: { current: null, initiator: null },
    id: sessionKey,
    turn: { id: sessionKey, sequence: 0 },
  },
  storagePath: path.join(tmpdir(), sessionKey),
};
let handle: Awaited<ReturnType<typeof provider.start>>["handle"] | undefined;

try {
  // This diagnostic owns no managed workspace or skill resources. The provider
  // still supplies the same authenticated command authority and lifecycle.
  ({ handle } = await provider.start(context, undefined, { files: [] }));
  const receipt = await acquireCanonicalArrustedTemplate({
    callId: sessionKey,
    sandbox: handle.sandbox,
  });
  if (receipt.version !== 4)
    throw new Error("The canonical starter did not produce a cloned receipt.");
  const workspace = await inspectCanonicalArrustedSandboxWorkspace({
    receipt,
    sandbox: handle.sandbox,
  });
  process.stdout.write(
    `${JSON.stringify({
      contractDigest: receipt.contractDigest,
      eligibilityDigest: receipt.eligibilityDigest,
      ok: true,
      project: linkedProject.projectName,
      provider: "vercel-sandbox",
      sourceSha: receipt.sourceSha,
      sourceTree: receipt.sourceTree,
      workspaceDigest: workspace.workspaceDigest,
    })}\n`,
  );
} finally {
  try {
    await handle?.onRuntimeShutdown();
  } finally {
    delete process.env.VERCEL_OIDC_TOKEN;
    for (const key of requiredEnvironmentKeys) Reflect.deleteProperty(process.env, key);
  }
}
