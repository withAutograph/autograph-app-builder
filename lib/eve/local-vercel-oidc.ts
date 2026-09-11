import {
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

type LinkedVercelProject = {
  projectId: string;
  orgId: string;
  projectName: string;
};

type VercelOidcClaims = {
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  nbf: number;
  exp: number;
  owner: string;
  owner_id: string;
  project: string;
  project_id: string;
  environment: string;
};

function assertOwnerNonWritable(path: string): void {
  const stat = statSync(path);
  const ownerId = process.getuid?.();
  if (
    ownerId === undefined ||
    stat.uid !== ownerId ||
    (stat.mode & 0o022) !== 0
  ) {
    throw new Error("Installed Eve input was not owner-bound.");
  }
}

function assertOwnerBoundDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Installed Eve input was not an owner-bound directory.");
  }
  assertOwnerNonWritable(path);
}

function isContainedPath(parent: string, candidate: string): boolean {
  const relativeCandidate = relative(parent, candidate);
  return (
    relativeCandidate.length > 0 &&
    !isAbsolute(relativeCandidate) &&
    relativeCandidate !== ".." &&
    !relativeCandidate.startsWith(`..${sep}`)
  );
}

export function resolveInstalledEveCli(repositoryRootInput: string): string {
  const repositoryRoot = realpathSync(repositoryRootInput);
  if (repositoryRoot !== resolve(repositoryRootInput)) {
    throw new Error("Repository root was not canonical.");
  }
  const nodeModules = join(repositoryRoot, "node_modules");
  const pnpmRoot = join(nodeModules, ".pnpm");
  const packageLink = join(nodeModules, "eve");
  assertOwnerBoundDirectory(nodeModules);
  assertOwnerBoundDirectory(pnpmRoot);
  const packageLinkStat = lstatSync(packageLink);
  if (
    !packageLinkStat.isSymbolicLink() ||
    packageLinkStat.uid !== process.getuid?.() ||
    realpathSync(dirname(packageLink)) !== dirname(packageLink)
  ) {
    throw new Error("Installed Eve did not use the expected pnpm layout.");
  }
  const rawTarget = readlinkSync(packageLink, "utf8");
  if (
    isAbsolute(rawTarget) ||
    rawTarget.split("/").includes("..") ||
    !/^\.pnpm\/eve@0\.44\.4(?:_[^/]+)?\/node_modules\/eve$/u.test(rawTarget)
  ) {
    throw new Error("Installed Eve package link was invalid.");
  }
  const packageRoot = realpathSync(packageLink);
  const relativePackageRoot = relative(pnpmRoot, packageRoot);
  if (
    !isContainedPath(pnpmRoot, packageRoot) ||
    !/^eve@0\.44\.4(?:_[^/]+)?\/node_modules\/eve$/u.test(relativePackageRoot)
  ) {
    throw new Error("Installed Eve resolved outside the pinned pnpm package.");
  }
  const cli = join(packageRoot, "bin/eve.js");
  const metadataPath = join(packageRoot, "package.json");
  const packageNodeModules = dirname(packageRoot);
  const packageStoreRoot = dirname(packageNodeModules);
  for (const path of [
    packageStoreRoot,
    packageNodeModules,
    packageRoot,
    join(packageRoot, "bin"),
  ]) {
    assertOwnerBoundDirectory(path);
  }
  for (const path of [cli, metadataPath]) {
    assertOwnerNonWritable(path);
  }
  if (
    lstatSync(cli).isSymbolicLink() ||
    !lstatSync(cli).isFile() ||
    (statSync(cli).mode & 0o111) === 0
  ) {
    throw new Error("Installed Eve CLI was not an exact executable file.");
  }
  const metadata = closedObject(
    JSON.parse(readFileSync(metadataPath, "utf8")) as unknown,
    "Installed Eve package",
  );
  const bin = closedObject(metadata.bin, "Installed Eve bin");
  if (
    metadata.name !== "eve" ||
    metadata.version !== "0.44.4" ||
    bin.eve !== "./bin/eve.js"
  ) {
    throw new Error("Installed Eve package identity was invalid.");
  }
  const rootMetadata = closedObject(
    JSON.parse(
      readFileSync(join(repositoryRoot, "package.json"), "utf8"),
    ) as unknown,
    "Repository package",
  );
  const dependencies = closedObject(
    rootMetadata.dependencies,
    "Repository dependencies",
  );
  if (dependencies.eve !== "0.44.4") {
    throw new Error("Repository Eve dependency was not pinned to 0.44.4.");
  }
  return cli;
}

function closedObject(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} was not an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`Required ${key} was unavailable.`);
  }
  return candidate;
}

function requiredInteger(value: Record<string, unknown>, key: string): number {
  const candidate = value[key];
  if (!Number.isSafeInteger(candidate)) {
    throw new Error(`Required ${key} was unavailable.`);
  }
  return candidate as number;
}

export function parseLinkedVercelProject(source: string): LinkedVercelProject {
  const value = closedObject(JSON.parse(source) as unknown, "Vercel project");
  return {
    projectId: requiredString(value, "projectId"),
    orgId: requiredString(value, "orgId"),
    projectName: requiredString(value, "projectName"),
  };
}

export function readOwnerBoundLocalFile(
  path: string,
  input: { confidential: boolean; ownerId?: number } = {
    confidential: false,
  },
): string {
  const stat = lstatSync(path);
  const ownerId = input.ownerId ?? process.getuid?.();
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    ownerId === undefined ||
    stat.uid !== ownerId ||
    (stat.mode & (input.confidential ? 0o077 : 0o022)) !== 0
  ) {
    throw new Error("Local credential input was not an owner-bound file.");
  }
  return readFileSync(path, "utf8");
}

export function parseLocalVercelOidcToken(source: string): string {
  const matches = source
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("VERCEL_OIDC_TOKEN="));
  if (matches.length !== 1) {
    throw new Error("Expected exactly one VERCEL_OIDC_TOKEN entry.");
  }
  const encoded = matches[0]!.slice("VERCEL_OIDC_TOKEN=".length);
  const token = encoded.startsWith('"')
    ? (JSON.parse(encoded) as unknown)
    : encoded;
  if (
    typeof token !== "string" ||
    token.length > 8192 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)
  ) {
    throw new Error("VERCEL_OIDC_TOKEN was not a bounded JWT.");
  }
  return token;
}

function decodeClaims(token: string): VercelOidcClaims {
  const payload = token.split(".")[1];
  if (payload === undefined) throw new Error("OIDC payload was unavailable.");
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("OIDC payload was malformed.");
  }
  const claims = closedObject(decoded, "OIDC claims");
  return {
    iss: requiredString(claims, "iss"),
    aud: requiredString(claims, "aud"),
    sub: requiredString(claims, "sub"),
    iat: requiredInteger(claims, "iat"),
    nbf: requiredInteger(claims, "nbf"),
    exp: requiredInteger(claims, "exp"),
    owner: requiredString(claims, "owner"),
    owner_id: requiredString(claims, "owner_id"),
    project: requiredString(claims, "project"),
    project_id: requiredString(claims, "project_id"),
    environment: requiredString(claims, "environment"),
  };
}

export function validateLocalVercelOidcToken(input: {
  token: string;
  project: LinkedVercelProject;
  nowEpochSeconds: number;
}): string {
  validateLocalVercelOidcClaims(input);
  return input.token;
}

export function validateLocalVercelOidcClaims(input: {
  token: string;
  project: LinkedVercelProject;
  nowEpochSeconds: number;
  allowExpired?: boolean;
}): {
  issuerMode: "global" | "team";
  audienceBound: true;
  subjectBound: true;
  ownerBound: true;
  projectBound: true;
  environment: "development";
  issuedAt: number;
  notBefore: number;
  expiresAt: number;
} {
  const claims = decodeClaims(input.token);
  const expectedAudience = `https://vercel.com/${claims.owner}`;
  const expectedSubject = `owner:${claims.owner}:project:${input.project.projectName}:environment:development`;
  const issuerAllowed =
    claims.iss === "https://oidc.vercel.com" ||
    claims.iss === `https://oidc.vercel.com/${claims.owner}`;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(claims.owner) ||
    !issuerAllowed ||
    claims.aud !== expectedAudience ||
    claims.sub !== expectedSubject ||
    claims.owner_id !== input.project.orgId ||
    claims.project !== input.project.projectName ||
    claims.project_id !== input.project.projectId ||
    claims.environment !== "development"
  ) {
    throw new Error("OIDC token did not match the linked Development project.");
  }
  if (
    claims.iat > input.nowEpochSeconds ||
    claims.nbf > input.nowEpochSeconds ||
    (!input.allowExpired && claims.exp <= input.nowEpochSeconds) ||
    claims.nbf < claims.iat ||
    claims.exp - claims.iat > 43_200
  ) {
    throw new Error("OIDC token was not current and bounded.");
  }
  return {
    issuerMode: claims.iss === "https://oidc.vercel.com" ? "global" : "team",
    audienceBound: true,
    subjectBound: true,
    ownerBound: true,
    projectBound: true,
    environment: "development",
    issuedAt: claims.iat,
    notBefore: claims.nbf,
    expiresAt: claims.exp,
  };
}
