import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import nodePath from "node:path";

interface LinkedVercelProject {
  projectId: string;
  orgId: string;
  projectName: string;
}

interface VercelOidcClaims {
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
}

const OWNER_BOUND_INPUT_ERROR = "Installed Eve input was not owner-bound.";

const closedObject = (value: unknown, name: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} was not an object.`);
  }
  return value as Record<string, unknown>;
};

const assertOwnerNonWritable = (path: string): void => {
  const stat = statSync(path);
  const ownerId = process.getuid?.();
  // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
  if (ownerId === undefined || stat.uid !== ownerId || (stat.mode & 0o022) !== 0) {
    throw new Error(OWNER_BOUND_INPUT_ERROR);
  }
};

const assertOwnerBoundDirectory = (path: string): void => {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Installed Eve input was not an owner-bound directory.");
  }
  assertOwnerNonWritable(path);
};

const isContainedPath = (parent: string, candidate: string): boolean => {
  const relativeCandidate = nodePath.relative(parent, candidate);
  return (
    relativeCandidate.length > 0 &&
    !nodePath.isAbsolute(relativeCandidate) &&
    relativeCandidate !== ".." &&
    !relativeCandidate.startsWith(`..${nodePath.sep}`)
  );
};

const assertOwnerBoundResolvedDirectory = (path: string, packageRoot = path): void => {
  const ownerId = process.getuid?.();
  if (ownerId === undefined) {
    throw new Error(OWNER_BOUND_INPUT_ERROR);
  }
  let current = realpathSync(path);
  const boundary = realpathSync(packageRoot);
  if (current !== boundary && !isContainedPath(boundary, current)) {
    throw new Error(OWNER_BOUND_INPUT_ERROR);
  }
  let insidePackage = true;
  for (;;) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Installed Eve input was not an owner-bound directory.");
    }
    if (insidePackage && stat.uid !== ownerId) {
      throw new Error(OWNER_BOUND_INPUT_ERROR);
    }
    // Reject directories another local account can replace files from. A
    // sticky shared temporary directory remains safe for its owner to use.
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional permission and sticky-bit checks.
    const writableByOthers = (stat.mode & 0o022) !== 0;
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional permission and sticky-bit checks.
    const sticky = (stat.mode & 0o1000) !== 0;
    if (writableByOthers && (stat.uid === ownerId || !sticky)) {
      throw new Error(OWNER_BOUND_INPUT_ERROR);
    }
    if (current === boundary) insidePackage = false;
    const parent = nodePath.dirname(current);
    if (parent === current) return;
    current = parent;
  }
};

export const resolveInstalledEveCli = (repositoryRootInput: string): string => {
  const repositoryRoot = realpathSync(repositoryRootInput);
  if (repositoryRoot !== nodePath.resolve(repositoryRootInput)) {
    throw new Error("Repository root was not canonical.");
  }
  const nodeModules = nodePath.join(repositoryRoot, "node_modules");
  const packageLink = nodePath.join(nodeModules, "eve");
  assertOwnerBoundDirectory(nodeModules);
  const packageLinkStat = lstatSync(packageLink);
  if (packageLinkStat.uid !== process.getuid?.()) {
    throw new Error(OWNER_BOUND_INPUT_ERROR);
  }
  if (!packageLinkStat.isSymbolicLink() && !packageLinkStat.isDirectory()) {
    throw new Error("Installed Eve package link was invalid.");
  }
  if (realpathSync(nodePath.dirname(packageLink)) !== nodePath.dirname(packageLink)) {
    throw new Error("Installed Eve package link was invalid.");
  }

  const repositoryPackagePath = nodePath.join(repositoryRoot, "package.json");
  assertOwnerNonWritable(repositoryPackagePath);
  const rootMetadata = closedObject(
    JSON.parse(readFileSync(repositoryPackagePath, "utf-8")) as unknown,
    "Repository package",
  );
  const declared = [
    rootMetadata.dependencies,
    rootMetadata.devDependencies,
    rootMetadata.optionalDependencies,
    rootMetadata.peerDependencies,
  ].some((section) => {
    if (section === undefined) return false;
    return Object.hasOwn(closedObject(section, "Repository dependencies"), "eve");
  });
  if (!declared) {
    throw new Error("Eve was not a declared repository dependency.");
  }

  let metadataPath: string;
  try {
    metadataPath = realpathSync(createRequire(repositoryPackagePath).resolve("eve/package.json"));
  } catch {
    throw new Error("Installed Eve package metadata was unavailable.");
  }
  const packageRoot = nodePath.dirname(metadataPath);
  if (realpathSync(packageLink) !== packageRoot) {
    throw new Error("Installed Eve package resolution did not match its direct dependency.");
  }
  assertOwnerBoundResolvedDirectory(packageRoot);
  assertOwnerNonWritable(metadataPath);
  const metadata = closedObject(
    JSON.parse(readFileSync(metadataPath, "utf-8")) as unknown,
    "Installed Eve package",
  );
  const bin =
    typeof metadata.bin === "string"
      ? metadata.bin
      : closedObject(metadata.bin, "Installed Eve bin").eve;
  if (metadata.name !== "eve" || typeof bin !== "string" || bin.length === 0) {
    throw new Error("Installed Eve package identity was invalid.");
  }
  const cliCandidate = nodePath.resolve(packageRoot, bin);
  if (nodePath.isAbsolute(bin) || !isContainedPath(packageRoot, cliCandidate)) {
    throw new Error("Installed Eve CLI target was invalid.");
  }
  const cli = realpathSync(cliCandidate);
  if (!isContainedPath(packageRoot, cli)) {
    throw new Error("Installed Eve CLI target resolved outside its package.");
  }
  assertOwnerBoundResolvedDirectory(nodePath.dirname(cli), packageRoot);
  assertOwnerNonWritable(cli);
  if (
    !statSync(cli).isFile() ||
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional executable-mode check.
    (statSync(cli).mode & 0o111) === 0
  ) {
    throw new Error("Installed Eve CLI was not an executable file.");
  }
  return cli;
};

const requiredString = (value: Record<string, unknown>, key: string): string => {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new TypeError(`Required ${key} was unavailable.`);
  }
  return candidate;
};

const requiredInteger = (value: Record<string, unknown>, key: string): number => {
  const candidate = value[key];
  if (!Number.isSafeInteger(candidate)) {
    throw new TypeError(`Required ${key} was unavailable.`);
  }
  return candidate as number;
};

export const parseLinkedVercelProject = (source: string): LinkedVercelProject => {
  const value = closedObject(JSON.parse(source) as unknown, "Vercel project");
  return {
    orgId: requiredString(value, "orgId"),
    projectId: requiredString(value, "projectId"),
    projectName: requiredString(value, "projectName"),
  };
};

const DEFAULT_OWNER_BOUND_FILE_INPUT = { confidential: false };

export const readOwnerBoundLocalFile = (
  path: string,
  input: { confidential: boolean; ownerId?: number } = DEFAULT_OWNER_BOUND_FILE_INPUT,
): string => {
  const stat = lstatSync(path);
  const ownerId = input.ownerId ?? process.getuid?.();
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    ownerId === undefined ||
    stat.uid !== ownerId ||
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    (stat.mode & (input.confidential ? 0o077 : 0o022)) !== 0
  ) {
    throw new Error("Local credential input was not an owner-bound file.");
  }
  return readFileSync(path, "utf-8");
};

export const parseLocalVercelOidcToken = (source: string): string => {
  const matches = source.split(/\r?\n/u).filter((line) => line.startsWith("VERCEL_OIDC_TOKEN="));
  const [match] = matches;
  if (matches.length !== 1 || match === undefined) {
    throw new Error("Expected exactly one VERCEL_OIDC_TOKEN entry.");
  }
  const encoded = match.slice("VERCEL_OIDC_TOKEN=".length);
  const token = encoded.startsWith('"') ? (JSON.parse(encoded) as unknown) : encoded;
  if (
    typeof token !== "string" ||
    token.length > 8192 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)
  ) {
    throw new Error("VERCEL_OIDC_TOKEN was not a bounded JWT.");
  }
  return token;
};

const decodeClaims = (token: string): VercelOidcClaims => {
  const [, payload] = token.split(".");
  if (payload === undefined) {
    throw new Error("OIDC payload was unavailable.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
  } catch {
    throw new Error("OIDC payload was malformed.");
  }
  const claims = closedObject(decoded, "OIDC claims");
  return {
    aud: requiredString(claims, "aud"),
    environment: requiredString(claims, "environment"),
    exp: requiredInteger(claims, "exp"),
    iat: requiredInteger(claims, "iat"),
    iss: requiredString(claims, "iss"),
    nbf: requiredInteger(claims, "nbf"),
    owner: requiredString(claims, "owner"),
    owner_id: requiredString(claims, "owner_id"),
    project: requiredString(claims, "project"),
    project_id: requiredString(claims, "project_id"),
    sub: requiredString(claims, "sub"),
  };
};

export const validateLocalVercelOidcClaims = (input: {
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
} => {
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
    audienceBound: true,
    environment: "development",
    expiresAt: claims.exp,
    issuedAt: claims.iat,
    issuerMode: claims.iss === "https://oidc.vercel.com" ? "global" : "team",
    notBefore: claims.nbf,
    ownerBound: true,
    projectBound: true,
    subjectBound: true,
  };
};

export const validateLocalVercelOidcToken = (input: {
  token: string;
  project: LinkedVercelProject;
  nowEpochSeconds: number;
}): string => {
  validateLocalVercelOidcClaims(input);
  return input.token;
};
