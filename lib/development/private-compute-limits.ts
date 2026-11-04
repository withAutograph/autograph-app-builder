import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { z } from "zod";
import { parseLinkedVercelProject, readOwnerBoundLocalFile } from "../eve/local-vercel-oidc";
import { privateComputeLimitsSchema } from "../sandbox/private-compute-profile";

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
    const { stdout } = await execute(
      input.vercelExecutable,
      ["api", `/v2/teams/${project.orgId}`, "--scope", project.orgId],
      {
        cwd: input.repositoryRoot,
        signal: input.signal,
        maxBuffer: Infinity,
        env: {
          HOME: input.environment.HOME,
          PATH: input.environment.PATH,
          NODE_ENV: "development",
          ...(input.environment.XDG_DATA_HOME === undefined
            ? {}
            : { XDG_DATA_HOME: input.environment.XDG_DATA_HOME }),
        },
      },
    );
    const team = teamSchema.parse(JSON.parse(stdout));
    if (team.id !== project.orgId || team.limited === true)
      throw new Error("Provider team unavailable");
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
