import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import nodePath from "node:path";
import { z } from "zod";

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

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
interface JsonObject {
  [key: string]: JsonValue;
}

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(
      z.string(),
      z.lazy(() => jsonValueSchema),
    ),
  ]),
);
const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);
const isJsonObject = (value: JsonValue): value is JsonObject =>
  jsonObjectSchema.safeParse(value).success;

const parseJsonObject = (source: string, name: string): JsonObject => {
  const parsed = jsonObjectSchema.safeParse(JSON.parse(source));
  if (!parsed.success) throw new Error(`${name} was not an object.`);
  return parsed.data;
};

const parseJsonString = (source: string): string => {
  const parsed = z.string().safeParse(JSON.parse(source));
  if (!parsed.success) throw new Error("JSON string was invalid.");
  return parsed.data;
};

const optionalString = (value: JsonValue | undefined): string | undefined => {
  const scalar = z.union([z.string(), z.number(), z.boolean()]).safeParse(value);
  if (!scalar.success) return undefined;
  return String(scalar.data);
};

const assertOwnerNonWritable = (path: string): void => {
  const stat = statSync(path);
  const ownerId = process.getuid?.();
  if (ownerId === undefined || stat.uid !== ownerId || (stat.mode & 0o022) !== 0) {
    throw new Error(OWNER_BOUND_INPUT_ERROR);
  }
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

const resolveOwnerBoundNodeModules = (repositoryRoot: string): string => {
  assertOwnerBoundResolvedDirectory(repositoryRoot);
  const nodeModulesLink = nodePath.join(repositoryRoot, "node_modules");
  const nodeModulesLinkStat = lstatSync(nodeModulesLink);
  if (nodeModulesLinkStat.uid !== process.getuid?.()) {
    throw new Error(OWNER_BOUND_INPUT_ERROR);
  }
  if (!nodeModulesLinkStat.isSymbolicLink() && !nodeModulesLinkStat.isDirectory()) {
    throw new Error("Installed Eve input was not an owner-bound directory.");
  }
  const nodeModules = realpathSync(nodeModulesLink);
  assertOwnerBoundResolvedDirectory(nodeModules);
  return nodeModules;
};

export const resolveInstalledEveCli = (repositoryRootInput: string): string => {
  const repositoryRoot = realpathSync(repositoryRootInput);
  if (repositoryRoot !== nodePath.resolve(repositoryRootInput)) {
    throw new Error("Repository root was not canonical.");
  }
  const nodeModules = resolveOwnerBoundNodeModules(repositoryRoot);
  const packageLink = nodePath.join(nodeModules, "eve");
  const packageLinkStat = lstatSync(packageLink);
  if (packageLinkStat.uid !== process.getuid?.()) {
    throw new Error(OWNER_BOUND_INPUT_ERROR);
  }
  if (!packageLinkStat.isSymbolicLink() && !packageLinkStat.isDirectory()) {
    throw new Error("Installed Eve package link was invalid.");
  }

  const repositoryPackagePath = nodePath.join(repositoryRoot, "package.json");
  assertOwnerNonWritable(repositoryPackagePath);
  const rootMetadata = parseJsonObject(
    readFileSync(repositoryPackagePath, "utf-8"),
    "Repository package",
  );
  const declared = [
    rootMetadata.dependencies,
    rootMetadata.devDependencies,
    rootMetadata.optionalDependencies,
    rootMetadata.peerDependencies,
  ].some((section) => {
    if (section === undefined) return false;
    return Object.hasOwn(parseJsonObject(section, "Repository dependencies"), "eve");
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
  const metadata = parseJsonObject(readFileSync(metadataPath, "utf-8"), "Installed Eve package");
  const binEntry = metadata.bin;
  let bin = optionalString(binEntry);
  if (bin === undefined && isJsonObject(binEntry)) {
    bin = optionalString(binEntry.eve);
  }
  if (metadata.name !== "eve" || bin === undefined || bin.length === 0) {
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

const parseRequiredString = (candidate: JsonValue | undefined, key: string): string => {
  const parsed = optionalString(candidate);
  if (parsed === undefined || parsed.length === 0) {
    throw new TypeError(`Required ${key} was unavailable.`);
  }
  return parsed;
};

const parseRequiredInteger = (candidate: JsonValue | undefined, key: string): number => {
  const parsed = optionalString(candidate);
  const integer = parsed === undefined ? Number.NaN : Number(parsed);
  if (!Number.isSafeInteger(integer) || candidate !== integer)
    throw new TypeError(`Required ${key} was unavailable.`);
  return integer;
};

const parseLinkedVercelProjectObject = (value: JsonObject): LinkedVercelProject => ({
  orgId: parseRequiredString(value.orgId, "orgId"),
  projectId: parseRequiredString(value.projectId, "projectId"),
  projectName: parseRequiredString(value.projectName, "projectName"),
});

export const parseLinkedVercelProject = (source: string): LinkedVercelProject => {
  const value = parseJsonObject(source, "Vercel project");
  return parseLinkedVercelProjectObject(value);
};

const DEFAULT_OWNER_BOUND_FILE_INPUT = { confidential: false };

export const readOwnerBoundLocalFile = (
  path: string,
  input: { confidential: boolean; ownerId?: number } = DEFAULT_OWNER_BOUND_FILE_INPUT,
): string => {
  const stat = lstatSync(path);
  const ownerId = input.ownerId ?? process.getuid?.();
  const invalidFile = !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1;
  const invalidOwner = ownerId === undefined || stat.uid !== ownerId;
  // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
  const unsafePermissions = (stat.mode & (input.confidential ? 0o077 : 0o022)) !== 0;
  if (invalidFile || invalidOwner || unsafePermissions) {
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
  const token = encoded.startsWith('"') ? parseJsonString(encoded) : encoded;
  const parsedToken = optionalString(token);
  if (
    parsedToken === undefined ||
    parsedToken.length > 8192 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(parsedToken)
  ) {
    throw new Error("VERCEL_OIDC_TOKEN was not a bounded JWT.");
  }
  return parsedToken;
};

const decodeClaims = (token: string): VercelOidcClaims => {
  const [, payload] = token.split(".");
  if (payload === undefined) {
    throw new Error("OIDC payload was unavailable.");
  }
  let claims: JsonObject;
  try {
    claims = parseJsonObject(Buffer.from(payload, "base64url").toString("utf-8"), "OIDC claims");
  } catch {
    throw new Error("OIDC payload was malformed.");
  }
  return {
    aud: parseRequiredString(claims.aud, "aud"),
    environment: parseRequiredString(claims.environment, "environment"),
    exp: parseRequiredInteger(claims.exp, "exp"),
    iat: parseRequiredInteger(claims.iat, "iat"),
    iss: parseRequiredString(claims.iss, "iss"),
    nbf: parseRequiredInteger(claims.nbf, "nbf"),
    owner: parseRequiredString(claims.owner, "owner"),
    owner_id: parseRequiredString(claims.owner_id, "owner_id"),
    project: parseRequiredString(claims.project, "project"),
    project_id: parseRequiredString(claims.project_id, "project_id"),
    sub: parseRequiredString(claims.sub, "sub"),
  };
};

interface ValidateLocalVercelOidcClaimsInput {
  token: string;
  project: LinkedVercelProject;
  nowEpochSeconds: number;
  allowExpired?: boolean;
}

interface ValidatedLocalVercelOidcClaims {
  issuerMode: "global" | "team";
  audienceBound: true;
  subjectBound: true;
  ownerBound: true;
  projectBound: true;
  environment: "development";
  issuedAt: number;
  notBefore: number;
  expiresAt: number;
}

export const validateLocalVercelOidcClaims = (
  input: ValidateLocalVercelOidcClaimsInput,
): ValidatedLocalVercelOidcClaims => {
  const claims = decodeClaims(input.token);
  const expectedAudience = `https://vercel.com/${claims.owner}`;
  const expectedSubject = `owner:${claims.owner}:project:${input.project.projectName}:environment:development`;
  const issuerAllowed =
    claims.iss === "https://oidc.vercel.com" ||
    claims.iss === `https://oidc.vercel.com/${claims.owner}`;
  const ownerIsValid = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(claims.owner);
  const projectClaimsMatch =
    claims.owner_id === input.project.orgId &&
    claims.project === input.project.projectName &&
    claims.project_id === input.project.projectId;
  const audienceMatches = claims.aud === expectedAudience;
  const subjectMatches = claims.sub === expectedSubject;
  const environmentMatches = claims.environment === "development";
  const projectIdentityMatches = projectClaimsMatch && environmentMatches;
  const tokenIdentityMatches =
    issuerAllowed && audienceMatches && subjectMatches && projectIdentityMatches;
  if (!ownerIsValid || !tokenIdentityMatches) {
    throw new Error("OIDC token did not match the linked Development project.");
  }
  const timeOrderInvalid =
    claims.iat > input.nowEpochSeconds ||
    claims.nbf > input.nowEpochSeconds ||
    claims.nbf < claims.iat;
  const lifetimeInvalid = claims.exp - claims.iat > 43_200;
  const expired = input.allowExpired !== true && claims.exp <= input.nowEpochSeconds;
  if (timeOrderInvalid || lifetimeInvalid || expired) {
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
