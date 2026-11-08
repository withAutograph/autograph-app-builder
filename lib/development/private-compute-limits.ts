import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { z } from "zod";
import { parseLinkedVercelProject, readOwnerBoundLocalFile } from "../eve/local-vercel-oidc";
import { privateComputeLimitsSchema } from "../sandbox/private-compute-profile";

// oxlint-disable-next-line typescript/strict-void-return -- Node execFile returns a ChildProcess handle alongside its callback; the official promisify adapter intentionally uses callback completion.
const execute = promisify(execFile);
const teamSchema = z.object({
  id: z.string(),
  billing: z.object({ plan: z.enum(["hobby", "pro", "enterprise"]) }),
  limited: z.boolean().optional(),
  softBlock: z.null().optional(),
});
/** The supervisor retains CLI account credentials; only these public provider facts reach Eve. */
export const observePrivateComputeLimits = async (input: {
  repositoryRoot: string;
  vercelExecutable: string;
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}) => {
  const project = parseLinkedVercelProject(
    readOwnerBoundLocalFile(path.join(input.repositoryRoot, ".vercel/project.json")),
  );
  try {
    const { vercelExecutable: executable } = input;
    const args = ["api", `/v2/teams/${project.orgId}`, "--scope", project.orgId];
    const cwd = input.repositoryRoot;
    const { signal } = input;
    const env: NodeJS.ProcessEnv = {
      HOME: input.environment.HOME,
      PATH: input.environment.PATH,
      NODE_ENV: "development",
    };
    if (input.environment.XDG_DATA_HOME !== undefined) {
      env.XDG_DATA_HOME = input.environment.XDG_DATA_HOME;
    }
    const { stdout } = await execute(executable, args, { cwd, signal, maxBuffer: Infinity, env });
    const team = teamSchema.parse(JSON.parse(stdout));
    if (team.id !== project.orgId || team.limited === true) {
      throw new Error("Provider team unavailable");
    }
    return privateComputeLimitsSchema.parse({
      version: 1,
      teamId: team.id,
      projectId: project.projectId,
      plan: team.billing.plan,
      maxVcpus: { hobby: 4, pro: 8, enterprise: 32 }[team.billing.plan],
      limited: false,
      observedAt: new Date().toISOString(),
    });
  } catch {
    throw new Error(
      "Provider team-plan observation was unavailable; private compute changes are unavailable. Existing default workspaces are unchanged.",
    );
  }
};
