import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  parseLinkedVercelProject,
  parseLocalVercelOidcToken,
  readOwnerBoundLocalFile,
  validateLocalVercelOidcClaims,
} from "../eve/local-vercel-oidc";
import { ensureLocalDevelopmentOidc } from "./local-oidc-startup";

const directory = (root: string) => {
  mkdirSync(root, { mode: 0o700, recursive: true });
  const info = lstatSync(root);
  if (
    realpathSync(root) !== root ||
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    // oxlint-disable-next-line eslint/no-bitwise -- Filesystem permissions are an actual confidentiality boundary.
    (info.mode & 0o077) !== 0
  ) {
    throw new Error("Development OIDC lease directory is not private.");
  }
};
const replace = (target: string, bytes: string) => {
  const temporary = `${target}.${randomUUID()}`;
  writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
  renameSync(temporary, target);
};

/** Only the supervisor has CLI access. Eve receives a renewable, project-scoped lease. */
export const publishLocalDevelopmentOidcLease = (input: {
  repositoryRoot: string;
  applicationRoot: string;
  runtimeHome: string;
  nowEpochSeconds?: number;
}) => {
  directory(input.runtimeHome);
  const projectBytes = readOwnerBoundLocalFile(
    path.join(input.repositoryRoot, ".vercel/project.json"),
    { confidential: false },
  );
  const project = parseLinkedVercelProject(projectBytes);
  const token = parseLocalVercelOidcToken(
    readOwnerBoundLocalFile(path.join(input.repositoryRoot, ".env.local"), { confidential: true }),
  );
  const claims = validateLocalVercelOidcClaims({
    nowEpochSeconds: input.nowEpochSeconds ?? Math.floor(Date.now() / 1000),
    project,
    token,
  });
  const metadata = path.join(input.applicationRoot, ".vercel");
  directory(metadata);
  const projectFile = path.join(metadata, "project.json");
  try {
    const existing = parseLinkedVercelProject(readFileSync(projectFile, "utf-8"));
    if (existing.projectId !== project.projectId || existing.orgId !== project.orgId) {
      throw new Error("Development OIDC lease project changed.");
    }
  } catch (error) {
    if (!Error.isError(error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  const data = path.join(input.runtimeHome, "data");
  directory(data);
  const cache = path.join(data, "com.vercel.token");
  directory(cache);
  const tokenFile = path.join(cache, `${project.projectId}.json`);
  if (path.dirname(tokenFile) !== cache) {
    throw new Error("Development OIDC lease cache path escaped its private directory.");
  }
  replace(projectFile, JSON.stringify(project));
  // @vercel/oidc's native cache is intentionally the only credential file here.
  // Never copy the host CLI auth/configuration or a refresh credential into Eve.
  replace(tokenFile, JSON.stringify({ token }));
  return { expiresAt: claims.expiresAt };
};

export const maintainLocalDevelopmentOidcLease = (
  input: Parameters<typeof publishLocalDevelopmentOidcLease>[0] & {
    vercelExecutable: string;
    miseExecutable: string;
    environment?: NodeJS.ProcessEnv;
    onUnavailable: () => void;
  },
) => {
  const renew = () => {
    ensureLocalDevelopmentOidc(input);
    publishLocalDevelopmentOidcLease(input);
  };
  renew();
  // Observe the existing five-minute renewal window; no session or worker restart.
  const timer = setInterval(() => {
    try {
      renew();
    } catch {
      input.onUnavailable();
    }
  }, 60_000);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
};
