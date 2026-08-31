import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  readdir,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const execFileAsync = promisify(execFile);
const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

const dependencyInputs = [
  ".config/mise/config.toml",
  ".config/mise/mise.lock",
  "bun.lock",
  "Cargo.lock",
] as const;

export type DevelopmentTools = Readonly<{
  node: string;
  bun: string;
  mise: string;
}>;

export type DevelopmentArguments = Readonly<{
  arrustedRoot: string;
  stateRoot?: string;
  destinationRoot?: string;
  nextPort: number;
  evePort: number;
}>;

export type DevelopmentSnapshot = Readonly<{
  root: string;
  fingerprint: string;
  commit: string;
  tree: string;
}>;

function argumentValue(args: readonly string[], index: number, name: string) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--"))
    throw new Error(`Missing value for ${name}.`);
  return value;
}

function port(value: string, name: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_024 || parsed > 65_535)
    throw new Error(`${name} must be an unprivileged TCP port.`);
  return parsed;
}

export function parseDevelopmentArguments(
  args: readonly string[],
): DevelopmentArguments {
  const parsed: {
    arrustedRoot?: string;
    stateRoot?: string;
    destinationRoot?: string;
    nextPort: number;
    evePort: number;
  } = { nextPort: 3_000, evePort: 2_000 };
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (name === undefined || !name.startsWith("--"))
      throw new Error("Development arguments must use named options.");
    const value = argumentValue(args, index, name);
    switch (name) {
      case "--arrusted-root":
        parsed.arrustedRoot = value;
        break;
      case "--state-root":
        parsed.stateRoot = value;
        break;
      case "--destination-root":
        parsed.destinationRoot = value;
        break;
      case "--next-port":
        parsed.nextPort = port(value, name);
        break;
      case "--eve-port":
        parsed.evePort = port(value, name);
        break;
      default:
        throw new Error(`Development option ${name} is unsupported.`);
    }
  }
  if (parsed.arrustedRoot === undefined)
    throw new Error("Usage: mise run dev -- --arrusted-root /absolute/path/to/arrusted");
  if (!isAbsolute(parsed.arrustedRoot))
    throw new Error("--arrusted-root must be absolute.");
  if (parsed.stateRoot !== undefined && !isAbsolute(parsed.stateRoot))
    throw new Error("--state-root must be absolute.");
  if (
    parsed.destinationRoot !== undefined &&
    !isAbsolute(parsed.destinationRoot)
  )
    throw new Error("--destination-root must be absolute.");
  return { ...parsed, arrustedRoot: parsed.arrustedRoot };
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/dev/null",
    XDG_CONFIG_HOME: "/dev/null",
    LC_ALL: "C",
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function canonicalOwnedDirectory(path: string, label: string) {
  const requested = resolve(path);
  if (!isAbsolute(path) || requested !== path || (await realpath(path)) !== path)
    throw new Error(`${label} must be an absolute canonical directory.`);
  const info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o022) !== 0
  )
    throw new Error(`${label} must be owned by the current account and not writable by another account.`);
  return path;
}

function safeRelativePath(path: string) {
  return (
    path !== "" &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

async function sourcePaths(sourceRoot: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "/usr/bin/git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "credential.helper=",
      "-C",
      sourceRoot,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    { encoding: "buffer", env: gitEnvironment(), maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((path) => safeRelativePath(path))
    .toSorted((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

async function sourceEntry(sourceRoot: string, path: string) {
  const absolute = join(sourceRoot, path);
  try {
    const info = await lstat(absolute);
    if (info.isFile())
      return {
        path,
        kind: "file" as const,
        mode: info.mode & 0o111 ? "100755" : "100644",
        content: await readFile(absolute),
      };
    if (info.isSymbolicLink()) {
      const target = await readlink(absolute);
      if (isAbsolute(target))
        throw new Error(`Development source link must be relative: ${path}`);
      const resolved = resolve(dirname(absolute), target);
      const escaped = relative(sourceRoot, resolved);
      if (escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped))
        throw new Error(`Development source link escapes the checkout: ${path}`);
      return {
        path,
        kind: "link" as const,
        mode: "120000",
        content: Buffer.from(target),
      };
    }
    throw new Error(`Development source supports only regular files and safe symbolic links: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function developmentEntries(sourceRoot: string) {
  const entries = await Promise.all(
    (await sourcePaths(sourceRoot)).map((path) => sourceEntry(sourceRoot, path)),
  );
  return entries.filter((entry) => entry !== undefined);
}

function fingerprintEntries(
  entries: readonly Awaited<ReturnType<typeof sourceEntry>>[],
) {
  const hash = createHash("sha256");
  for (const entry of entries) {
    if (entry === undefined) continue;
    const path = Buffer.from(entry.path);
    hash.update(Buffer.from(`${path.byteLength}\0${entry.kind}\0${entry.mode}\0${entry.content.byteLength}\0`));
    hash.update(path);
    hash.update(entry.content);
  }
  return hash.digest("hex");
}

export async function fingerprintDevelopmentSource(sourceRoot: string) {
  await canonicalOwnedDirectory(sourceRoot, "Arrusted checkout");
  return fingerprintEntries(await developmentEntries(sourceRoot));
}

async function makeReadOnly(root: string) {
  async function visit(path: string) {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        await visit(child);
        await chmod(child, 0o500);
      } else if (entry.isFile()) {
        const info = await stat(child);
        await chmod(child, info.mode & 0o111 ? 0o500 : 0o400);
      }
    }
  }
  await visit(root);
  await chmod(root, 0o500);
}

export async function createDevelopmentSnapshot(input: {
  sourceRoot: string;
  runRoot: string;
}): Promise<DevelopmentSnapshot> {
  const sourceRoot = await canonicalOwnedDirectory(
    input.sourceRoot,
    "Arrusted checkout",
  );
  const runRoot = await canonicalOwnedDirectory(input.runRoot, "Development run root");
  const root = join(runRoot, "source");
  await mkdir(root, { mode: 0o700 });
  try {
    const entries = await developmentEntries(sourceRoot);
    const fingerprint = fingerprintEntries(entries);
    for (const entry of entries) {
      await mkdir(dirname(join(root, entry.path)), { recursive: true, mode: 0o700 });
      if (entry.kind === "link")
        await symlink(entry.content.toString("utf8"), join(root, entry.path));
      else {
        await copyFile(join(sourceRoot, entry.path), join(root, entry.path));
        await chmod(join(root, entry.path), entry.mode === "100755" ? 0o700 : 0o600);
      }
    }
    if ((await fingerprintDevelopmentSource(sourceRoot)) !== fingerprint)
      throw new Error("Arrusted source changed while its development snapshot was created.");
    execFileSync("/usr/bin/git", ["init", "-q"], { cwd: root, env: gitEnvironment() });
    execFileSync("/usr/bin/git", ["add", "--all", "--", "."], {
      cwd: root,
      env: gitEnvironment(),
    });
    execFileSync(
      "/usr/bin/git",
      [
        "-c",
        "user.name=Autograph Development Snapshot",
        "-c",
        "user.email=development-snapshot@invalid.example",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        `Development snapshot ${fingerprint}`,
      ],
      {
        cwd: root,
        env: {
          ...gitEnvironment(),
          GIT_AUTHOR_DATE: "2000-01-01T00:00:00+00:00",
          GIT_COMMITTER_DATE: "2000-01-01T00:00:00+00:00",
        },
      },
    );
    const commit = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      env: gitEnvironment(),
    }).trim();
    const tree = execFileSync("/usr/bin/git", ["rev-parse", "HEAD^{tree}"], {
      cwd: root,
      encoding: "utf8",
      env: gitEnvironment(),
    }).trim();
    await makeReadOnly(root);
    return { root, fingerprint, commit, tree };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function digestFileOrAbsent(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`Dependency input must be a regular file: ${path}`);
    return sha256(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

export async function developmentDependencyKey(input: {
  sourceRoot: string;
  platform: string;
  tools: DevelopmentTools;
}) {
  const sourceRoot = await canonicalOwnedDirectory(input.sourceRoot, "Arrusted checkout");
  if (!/^linux\/(?:arm64|amd64)$/u.test(input.platform))
    throw new Error("Development dependency platform is unsupported.");
  const lockfiles = Object.fromEntries(
    await Promise.all(
      dependencyInputs.map(async (path) => [path, await digestFileOrAbsent(join(sourceRoot, path))]),
    ),
  );
  return sha256(
    JSON.stringify({ version: 1, platform: input.platform, tools: input.tools, lockfiles }),
  );
}
