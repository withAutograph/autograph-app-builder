import { randomUUID } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import { acquireHostedEvalOidc } from "../eve/hosted-eval-oidc";
import type { HostedEvalWorker, EvalArtifact } from "./hosted-self-reproduction-controller";
import { hostedEvalBootstrapFiles } from "./hosted-self-reproduction-worker-bootstrap";

// Keep the VM available after the evaluation deadline for artifact collection and cleanup.
export const hostedEvalCollectionGraceMs = 5 * 60 * 1000;
export const hostedEvalIdentityPath = "/tmp/self-reproduction-identity.json";
const artifacts: Record<string, string> = {
  "evidence.tar.gz": "application/gzip",
  "worker.log": "text/plain",
};
const decodeWorker = (value: string): { sandboxName: string; commandId: string } => {
  const parsed = JSON.parse(value);
  if (typeof parsed.sandboxName !== "string" || typeof parsed.commandId !== "string")
    throw new Error("Recorded eval worker identity is invalid.");
  return parsed;
};

/** Source access is deployment-owned; GitHub App keys never leave its reader. */
export const createHostedEvalSandboxWorker = (input: {
  /** Deployment-owned revision, never accepted from a start request. */
  builderRevision: string;
  scope: { projectId: string; teamId: string; environment: string };
  templateReader: { acquire: () => Promise<{ token: string }> };
  sdk?: Pick<typeof Sandbox, "create" | "get">;
  acquireOidc?: typeof acquireHostedEvalOidc;
  now?: () => number;
}): HostedEvalWorker => {
  const sdk = input.sdk ?? Sandbox;
  const credentials = () => (input.acquireOidc ?? acquireHostedEvalOidc)(input.scope);
  const identityFile = (auth: Awaited<ReturnType<typeof acquireHostedEvalOidc>>, path: string) => ({
    content: Buffer.from(JSON.stringify({ ...auth, environment: input.scope.environment })),
    path,
  });
  const writeIdentity = async (
    sandbox: Sandbox,
    auth: Awaited<ReturnType<typeof acquireHostedEvalOidc>>,
  ) => {
    const temporary = `${hostedEvalIdentityPath}.${randomUUID()}`;
    await sandbox.writeFiles([identityFile(auth, temporary)]);
    const permissions = await sandbox.runCommand({
      args: ["600", temporary],
      cmd: "chmod",
    });
    if (permissions.exitCode !== 0)
      throw new Error("Hosted workload identity file permissions failed.");
    const promoted = await sandbox.runCommand({
      args: ["-f", temporary, hostedEvalIdentityPath],
      cmd: "mv",
    });
    if (promoted.exitCode !== 0) throw new Error("Hosted workload identity refresh failed.");
  };
  const reconnect = async (workerId: string, refreshIdentity = true) => {
    const identity = decodeWorker(workerId);
    const auth = await credentials();
    const sandbox = await sdk.get({
      name: identity.sandboxName,
      projectId: auth.projectId,
      resume: false,
      teamId: auth.teamId,
      token: auth.token,
    });
    if (refreshIdentity) {
      await writeIdentity(sandbox, auth);
    }
    return { identity, sandbox };
  };
  return {
    // The SDK does not provide an idempotent create receipt lookup by our operation ID.
    // An interrupted start remains unknown; controller never launches a replacement.
    // oxlint-disable-next-line unicorn/no-useless-undefined -- typed Promise overload requires explicit undefined
    find: () => Promise.resolve<{ workerId: string } | undefined>(undefined),
    async inspect(workerId) {
      const { sandbox, identity } = await reconnect(workerId);
      const buffer = await sandbox.readFileToBuffer({
        path: "/tmp/self-reproduction-worker/result.json",
      });
      if (buffer === null) {
        const command = await sandbox.getCommand(identity.commandId);
        const log = await sandbox.readFileToBuffer({
          path: "/tmp/self-reproduction-worker/worker.log",
        });
        return {
          artifacts: log?.length ? [{ contentType: "text/plain", id: "worker.log" }] : [],
          status: command.exitCode === null ? "running" : "failed",
        };
      }
      const result = JSON.parse(buffer.toString("utf-8"));
      if (!["completed", "failed"].includes(result.status) || !Array.isArray(result.artifacts))
        throw new Error("Hosted evaluator completion receipt is invalid.");
      const manifest: EvalArtifact[] = result.artifacts.map((artifact: EvalArtifact) => {
        if (artifacts[artifact.id] !== artifact.contentType)
          throw new Error("Hosted evaluator artifact is outside the fixed allowlist.");
        return { contentType: artifact.contentType, id: artifact.id };
      });
      return { artifacts: manifest, status: result.status };
    },
    async readArtifact(workerId, id) {
      if (!Object.hasOwn(artifacts, id))
        throw new Error("Hosted evaluator artifact is unavailable.");
      const { sandbox } = await reconnect(workerId);
      const content = await sandbox.readFileToBuffer({
        path: `/tmp/self-reproduction-worker/${id}`,
      });
      if (content === null) throw new Error("Hosted evaluator artifact is missing.");
      return content;
    },
    async start({ cleanupAt, operationId }) {
      const auth = await credentials();
      const source = await input.templateReader.acquire();
      const sandbox = await sdk.create({
        name: `self-reproduction-${operationId}`,
        networkPolicy: "allow-all",
        persistent: false,
        projectId: auth.projectId,
        runtime: "node24",
        source: {
          revision: input.builderRevision,
          type: "git",
          url: "https://github.com/withAutograph/autograph-app-builder.git",
        },
        teamId: auth.teamId,
        timeout: Math.max(1, cleanupAt + hostedEvalCollectionGraceMs - (input.now ?? Date.now)()),
        token: auth.token,
      });
      try {
        await sandbox.writeFiles(hostedEvalBootstrapFiles());
        await writeIdentity(sandbox, auth);
        const command = await sandbox.runCommand({
          args: [
            "/tmp/self-reproduction-worker-bootstrap.mjs",
            "/tmp/self-reproduction-worker-config.json",
          ],
          cmd: "node",
          cwd: "/vercel/sandbox",
          detached: true,
          env: {
            APP_BUILDER_TEMPLATE_READ_TOKEN: source.token,
            SELF_REPRODUCTION_WORKLOAD_IDENTITY_FILE: hostedEvalIdentityPath,
            VERCEL_ENV: input.scope.environment,
            VERCEL_OIDC_TOKEN: auth.token,
            VERCEL_PROJECT_ID: auth.projectId,
            VERCEL_TEAM_ID: auth.teamId,
          },
        });
        return {
          workerId: JSON.stringify({ commandId: command.cmdId, sandboxName: sandbox.name }),
        };
      } catch {
        await sandbox.stop().catch(() => {
          // Provider timeout still bounds cleanup.
        });
        throw new Error("Hosted evaluator worker launch failed; provider timeout bounds cleanup.");
      }
    },
    async stop(workerId) {
      const { sandbox } = await reconnect(workerId, false);
      await sandbox.stop();
    },
  };
};
