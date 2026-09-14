import path from "node:path";

import { ensureLocalDevelopmentOidc } from "../lib/development/local-oidc-startup";
import {
  parseLinkedVercelProject,
  parseLocalVercelOidcToken,
  readOwnerBoundLocalFile,
  validateLocalVercelOidcToken,
} from "../lib/eve/local-vercel-oidc";

export const loadEveEvalOidc = (input: {
  realSandbox: boolean;
  repositoryRoot: string;
  miseExecutable?: string;
  vercelExecutable?: string;
  environment?: NodeJS.ProcessEnv;
  ensure?: (repositoryRoot: string) => void;
}): void => {
  const environment = input.environment ?? process.env;
  if (!input.realSandbox) {
    for (const name of ["VERCEL_OIDC_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"]) {
      Reflect.deleteProperty(environment, name);
    }
    return;
  }
  const ensure =
    input.ensure ??
    ((repositoryRoot: string) => {
      const { miseExecutable, vercelExecutable } = input;
      if (miseExecutable === undefined || vercelExecutable === undefined) {
        throw new Error("Use the supported mise Sandbox task to resolve managed executables.");
      }
      ensureLocalDevelopmentOidc({ environment, miseExecutable, repositoryRoot, vercelExecutable });
    });
  try {
    ensure(input.repositoryRoot);
    const project = parseLinkedVercelProject(
      readOwnerBoundLocalFile(path.join(input.repositoryRoot, ".vercel/project.json"), {
        confidential: false,
      }),
    );
    const token = parseLocalVercelOidcToken(
      readOwnerBoundLocalFile(path.join(input.repositoryRoot, ".env.local"), {
        confidential: true,
      }),
    );
    environment.VERCEL_OIDC_TOKEN = validateLocalVercelOidcToken({
      nowEpochSeconds: Math.floor(Date.now() / 1000),
      project,
      token,
    });
    environment.VERCEL_TEAM_ID = project.orgId;
    environment.VERCEL_PROJECT_ID = project.projectId;
  } catch {
    throw new Error(
      "Real Sandbox eval requires this checkout's linked Vercel project and current managed Development OIDC. Check the existing project link and run `mise run local:ensure-oidc`, then retry. Static credentials are unsupported.",
    );
  }
};
