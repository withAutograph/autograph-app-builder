import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { z } from "zod";
import { parseLinkedVercelProject, readOwnerBoundLocalFile } from "../eve/local-vercel-oidc";
import { privateComputeLimitsSchema } from "../sandbox/private-compute-profile";

// oxlint-disable-next-line typescript/strict-void-return -- Node execFile returns a ChildProcess handle alongside its callback; the official promisify adapter intentionally uses callback completion.
const execute = promisify(execFile);
const teamSchema = z.object({
  billing: z.object({ plan: z.enum(["hobby", "pro", "enterprise"]) }),
  id: z.string(),
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
    const environment: NodeJS.ProcessEnv = {
      HOME: input.environment.HOME,
      NODE_ENV: "development",
      PATH: input.environment.PATH,
    };
    if (input.environment.XDG_DATA_HOME !== undefined) {
      environment.XDG_DATA_HOME = input.environment.XDG_DATA_HOME;
    }
    const { stdout } = await execute(
      input.vercelExecutable,
      ["api", `/v2/teams/${project.orgId}`, "--scope", project.orgId],
      {
        cwd: input.repositoryRoot,
        env: environment,
        maxBuffer: Infinity,
        signal: input.signal,
      },
    );
    const team = teamSchema.parse(JSON.parse(stdout));
    if (team.id !== project.orgId || team.limited === true) {
      throw new Error("Provider team unavailable");
    }
    return privateComputeLimitsSchema.parse({
      limited: false,
      maxVcpus: { enterprise: 32, hobby: 4, pro: 8 }[team.billing.plan],
      observedAt: new Date().toISOString(),
      plan: team.billing.plan,
      projectId: project.projectId,
      teamId: team.id,
      version: 1,
    });
  } catch {
    throw new Error(
      "Provider team-plan observation was unavailable; private compute changes are unavailable. Existing default workspaces are unchanged.",
    );
  }
};
