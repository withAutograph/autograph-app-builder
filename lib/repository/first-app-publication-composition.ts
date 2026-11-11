import { createHash, randomUUID } from "node:crypto";
import nodePath from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";
import { builderAppIdSchema } from "../provisioning/names";
import { planApplicationSourceRegistration } from "./application-source-registration";
import { frameworkVersionsSchema } from "./framework-upgrade";
import type { FrameworkVersions } from "./framework-upgrade";
import type { GitHubRepositoryObservation } from "./github-publication";
import { planOwnedAppRootManifest } from "./owned-app-root-manifest";

const workspace = "/workspace";
const checkout = `${workspace}/repository`;
const packagePath = "package.json";
const routingPath = "microfrontends.json";
const lockPath = "bun.lock";
const compositionPaths = [packagePath, routingPath, lockPath] as const;
const objectId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const gitSourceSchema = z.strictObject({ sha: objectId, tree: objectId });
const repositoryComponent = z.string().regex(/^(?!\.{1,2}$)[A-Za-z0-9_.-]+$/u);
const compositionFileSchema = z.strictObject({
  content: z.string(),
  mode: z.enum(["644", "755"]),
});
const baseSchema = z.strictObject({
  appManifest: z.string(),
  packageJson: compositionFileSchema,
  routes: compositionFileSchema,
  lock: z.strictObject({
    digest: z.string().regex(/^[a-f0-9]{64}$/u),
    mode: z.enum(["644", "755"]),
  }),
});
const routesSchema = z.object({ applications: z.record(z.string(), z.json()) }).catchall(z.json());
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
const digest = (value: string) => createHash("sha256").update(value, "utf-8").digest("hex");

type CompositionPath = (typeof compositionPaths)[number];
type GitSource = z.infer<typeof gitSourceSchema>;
type Destination = Pick<
  GitHubRepositoryObservation,
  "owner" | "name" | "headSha" | "headTree" | "defaultBranch"
>;

interface AppSourceInput {
  sandbox: SandboxSession;
  appId: string;
  acquired: GitSource;
  signal?: AbortSignal;
}
export interface FirstAppPublicationFile {
  path: CompositionPath;
  content: string;
  digest: string;
  mode: "644" | "755";
}

// Use a fresh Git checkout for projection. The original checkout's config,
// worktree, index, filters and refs do not participate in the Bun install.
const gitProgram = String.raw`
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const input = JSON.parse(process.argv[1]);
const gitEnv = {
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_NO_LAZY_FETCH: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/usr/bin/false",
};
const git = (root, args, config = []) => execFileSync("git", [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "credential.helper=",
  "-c", "protocol.allow=never",
  "-c", "http.followRedirects=false",
  ...config,
  "-C", root,
  ...args,
], { encoding: "utf-8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] });
const exactTree = (root, pin) => {
  if (git(root, ["rev-parse", "--verify", pin.sha + "^{commit}"]).trim() !== pin.sha ||
      git(root, ["rev-parse", "--verify", pin.sha + "^{tree}"]).trim() !== pin.tree) {
    throw Error("The saved source or destination tree changed.");
  }
};
const appAbsent = (root, pin) =>
  git(root, ["--literal-pathspecs", "ls-tree", "-z", pin.tree, "--", "apps/" + input.appId]) === "";
const exactDirectory = root => {
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) {
    throw Error("The publication directory is not a real workspace directory.");
  }
};
const regular = (root, path, optional = false) => {
  const file = join(root, path);
  if (optional && lstatSync(file, { throwIfNoEntry: false }) === undefined) return null;
  if (realpathSync(file) !== file || !lstatSync(file).isFile()) {
    throw Error("The publication input is not a regular file.");
  }
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw Error("The publication input changed while it was read.");
    return {
      content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(fd)),
      mode: stat.mode & 64 ? "755" : "644",
    };
  } finally { closeSync(fd); }
};
const lockMetadata = root => {
  const lock = regular(root, "bun.lock");
  return { digest: createHash("sha256").update(lock.content, "utf-8").digest("hex"), mode: lock.mode };
};
`;

const inspectAcquiredProgram = `${gitProgram}
exactDirectory(input.checkout);
exactTree(input.checkout, input.acquired);
console.log(JSON.stringify(appAbsent(input.checkout, input.acquired)));
`;

const initializeProgram = `${gitProgram}
exactDirectory(input.checkout);
exactTree(input.checkout, input.acquired);
if (!appAbsent(input.checkout, input.acquired)) {
  throw Error("The selected app already exists in the acquired source.");
}
exactDirectory(input.applyRoot);
for (const file of input.paths) regular(input.applyRoot, file, true);
regular(input.applyRoot, "apps/" + input.appId + "/package.json");
let destinationPresent = true;
try { git(input.checkout, ["cat-file", "-e", input.destination.sha + "^{commit}"]); }
catch { destinationPresent = false; }
if (!destinationPresent &&
    git(input.checkout, ["remote", "get-url", "origin"]).trim() !== input.remote) {
  throw Error("The selected GitHub destination is unavailable in the acquired checkout.");
}
mkdirSync(input.root, { mode: 448 });
git(input.root, ["init", "--quiet", "--template="]);
console.log(JSON.stringify(destinationPresent ? "local" : "remote"));
`;

const fetchProgram = String.raw`${gitProgram}
exactDirectory(input.root);
try {
  git(input.root, [
    "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules",
    "--depth=1", input.transport, input.sha,
  ], ["-c", input.protocol + ".allow=always"]);
} catch (error) {
  if (String(error.stderr).includes("remote: Repository not found.")) {
    process.stderr.write("remote: Repository not found.\n");
  }
  process.exitCode = error.status ?? 1;
}
`;

const prepareProgram = `${gitProgram}
exactDirectory(input.root);
exactTree(input.root, input.destination);
if (!appAbsent(input.root, input.destination)) {
  throw Error("The selected app already exists in the destination.");
}
git(input.root, ["checkout", "--quiet", "--detach", input.destination.sha]);
exactDirectory(input.applyRoot);
const appPath = "apps/" + input.appId;
const appManifest = regular(input.applyRoot, appPath + "/package.json").content;
const base = {
  appManifest,
  packageJson: regular(input.root, "package.json"),
  routes: regular(input.root, "microfrontends.json"),
  lock: lockMetadata(input.root),
};
const apps = join(input.root, "apps");
if (lstatSync(apps, { throwIfNoEntry: false }) === undefined) mkdirSync(apps);
exactDirectory(apps);
mkdirSync(join(input.root, appPath));
writeFileSync(join(input.root, appPath, "package.json"), appManifest, { flag: "wx" });
console.log(JSON.stringify(base));
`;

const restoreLockProgram = `${gitProgram}
exactDirectory(input.root);
git(input.root, ["restore", "--source=" + input.sha, "--worktree", "--", "bun.lock"]);
`;

const inspectProjectionProgram = `${gitProgram}
exactDirectory(input.applyRoot);
for (const file of input.paths) regular(input.applyRoot, file, true);
exactDirectory(input.root);
console.log(JSON.stringify({
  appManifest: regular(input.applyRoot, "apps/" + input.appId + "/package.json").content,
  packageJson: regular(input.root, "package.json"),
  routes: regular(input.root, "microfrontends.json"),
  lock: lockMetadata(input.root),
}));
`;

const runChecked = async (
  input: Pick<AppSourceInput, "sandbox" | "signal">,
  command: string,
  workingDirectory: string,
  failure: string,
) => {
  input.signal?.throwIfAborted();
  const result = await input.sandbox.run({
    abortSignal: input.signal,
    command,
    workingDirectory,
  });
  input.signal?.throwIfAborted();
  if (result.exitCode !== 0) {
    throw new Error(failure);
  }
  return result.stdout;
};

const programCommand = (program: string, argumentsJson: string) =>
  `node -e ${quote(program)} ${quote(argumentsJson)}`;

const runProgram = async (
  input: Pick<AppSourceInput, "sandbox" | "signal">,
  program: string,
  argumentsJson: string,
  failure: string,
) => await runChecked(input, programCommand(program, argumentsJson), workspace, failure);

const fetchDestination = async (
  input: Pick<AppSourceInput, "sandbox" | "signal">,
  options: {
    root: string;
    sha: string;
    transport: string;
    protocol: "protocol.file" | "protocol.https";
  },
) => {
  input.signal?.throwIfAborted();
  const result = await input.sandbox.run({
    abortSignal: input.signal,
    command: programCommand(fetchProgram, JSON.stringify(options)),
    workingDirectory: workspace,
  });
  input.signal?.throwIfAborted();
  if (result.exitCode !== 0) {
    const diagnostic = result.stderr.includes("remote: Repository not found.")
      ? " remote: Repository not found."
      : "";
    throw new Error(
      `Builder could not fetch the current base branch (exit ${result.exitCode}).${diagnostic}`,
    );
  }
};

export const acquiredSourceLacksApp = async (input: AppSourceInput): Promise<boolean> => {
  const appId = builderAppIdSchema.parse(input.appId);
  const acquired = gitSourceSchema.parse(input.acquired);
  const result = await runProgram(
    input,
    inspectAcquiredProgram,
    JSON.stringify({ acquired, appId, checkout }),
    "Builder could not verify the app's absence in its acquired Git source.",
  );
  return z.boolean().parse(JSON.parse(result));
};

const trustedRepositoryCommand = (root: string, command: string) =>
  `MISE_TRUSTED_CONFIG_PATHS="$MISE_TRUSTED_CONFIG_PATHS:"${quote(root)} mise exec --no-deps -- ${command}`;

const assertOnlyAppRegistration = (appId: string, beforeBytes: string, afterBytes: string) => {
  const before = routesSchema.parse(JSON.parse(beforeBytes));
  const after = routesSchema.parse(JSON.parse(afterBytes));
  const { [appId]: added, ...existing } = after.applications;
  if (
    Object.hasOwn(before.applications, appId) ||
    added === undefined ||
    !isDeepStrictEqual(before, { ...after, applications: existing })
  ) {
    throw new Error("The destination's existing app registrations must be preserved.");
  }
};

const rootWithAcceptedFrameworkPins = (
  bytes: string,
  frameworkUpgrade: FrameworkVersions | undefined,
): string => {
  if (frameworkUpgrade === undefined) {
    return bytes;
  }
  const versions = frameworkVersionsSchema.parse(frameworkUpgrade);
  const manifest = z.record(z.string(), z.json()).parse(JSON.parse(bytes));
  const catalog = z.record(z.string(), z.string()).parse(manifest.catalog);
  const pinned = {
    ...catalog,
    next: versions.next,
    react: versions.react,
    "react-dom": versions.reactDom,
    "@types/react": versions.typesReact,
    "@types/react-dom": versions.typesReactDom,
  };
  return isDeepStrictEqual(catalog, pinned)
    ? bytes
    : `${JSON.stringify({ ...manifest, catalog: pinned }, null, 2)}\n`;
};

const projectedFile = (
  path: CompositionPath,
  before: z.infer<typeof compositionFileSchema>,
  after: z.infer<typeof compositionFileSchema>,
): FirstAppPublicationFile[] =>
  before.content === after.content
    ? []
    : [{ path, content: after.content, digest: digest(after.content), mode: before.mode }];

/** Rebuild only the selected new app's registration from the immutable destination. */
export const planFirstAppPublicationComposition = async (
  input: AppSourceInput & {
    applyRoot: string;
    destination: Destination;
    frameworkUpgrade?: FrameworkVersions;
    withDestinationFetch?: (fetch: () => Promise<void>) => Promise<void>;
  },
): Promise<readonly FirstAppPublicationFile[]> => {
  input.signal?.throwIfAborted();
  const appId = builderAppIdSchema.parse(input.appId);
  const acquired = gitSourceSchema.parse(input.acquired);
  const { applyRoot, destination } = input;
  const outsideWorkspace =
    !applyRoot.startsWith(`${workspace}/`) ||
    applyRoot.endsWith("/") ||
    nodePath.posix.normalize(applyRoot) !== applyRoot;
  if (outsideWorkspace || applyRoot.includes("\0") || applyRoot.includes("\\")) {
    throw new Error("The app's private publication workspace is invalid.");
  }
  const target = gitSourceSchema.parse({ sha: destination.headSha, tree: destination.headTree });
  const owner = repositoryComponent.parse(destination.owner);
  const name = repositoryComponent.parse(destination.name);
  const root = `${workspace}/.first-app-publication-${randomUUID()}`;
  const paths = compositionPaths;
  try {
    const remote = `https://github.com/${owner}/${name}.git`;
    const initialized = await runProgram(
      input,
      initializeProgram,
      JSON.stringify({
        acquired,
        appId,
        applyRoot,
        checkout,
        destination: target,
        paths,
        remote,
        root,
      }),
      "Builder could not prepare the exact destination for the new app's registration.",
    );
    const location = z.enum(["local", "remote"]).parse(JSON.parse(initialized));
    if (location === "local") {
      await fetchDestination(input, {
        root,
        sha: target.sha,
        transport: checkout,
        protocol: "protocol.file",
      });
    } else {
      if (input.withDestinationFetch === undefined) {
        throw new Error(
          "Builder could not read the current destination. Restore the saved repository access and continue the same session.",
        );
      }
      await input.withDestinationFetch(async () => {
        await fetchDestination(input, {
          root,
          sha: target.sha,
          transport: remote,
          protocol: "protocol.https",
        });
      });
    }
    const prepared = await runProgram(
      input,
      prepareProgram,
      JSON.stringify({ appId, applyRoot, destination: target, root }),
      "Builder could not verify the exact new-app destination and its registration inputs.",
    );
    const base = baseSchema.parse(JSON.parse(prepared));
    z.object({ name: z.literal(`@autograph/${appId}`) }).parse(JSON.parse(base.appManifest));
    const pinnedBase = rootWithAcceptedFrameworkPins(
      base.packageJson.content,
      input.frameworkUpgrade,
    );
    const rootManifest = planOwnedAppRootManifest({
      appId,
      base: pinnedBase,
      originalPublished: pinnedBase,
      appManifest: base.appManifest,
    });
    const registration = await planApplicationSourceRegistration(
      input.sandbox,
      appId,
      base.routes.content,
      { workingDirectory: root, signal: input.signal },
    );
    if (registration.oldDigest !== digest(base.routes.content)) {
      throw new Error("The selected app registration changed during preparation.");
    }
    assertOnlyAppRegistration(appId, base.routes.content, registration.proposedBytes);
    const relativeRoot = root.slice(workspace.length + 1);
    const write = async (path: CompositionPath, content: string) => {
      await input.sandbox.writeTextFile({
        path: `${relativeRoot}/${path}`,
        content,
        abortSignal: input.signal,
      });
    };
    input.signal?.throwIfAborted();
    await Promise.all([
      write(packagePath, rootManifest),
      write(routingPath, registration.proposedBytes),
      // The planner may have installed its own inputs. Restore the exact base lock locally.
      runProgram(
        input,
        restoreLockProgram,
        JSON.stringify({ root, sha: target.sha }),
        "Builder could not restore the exact destination lockfile.",
      ),
    ]);
    await runChecked(
      input,
      trustedRepositoryCommand(root, "bun install --lockfile-only --ignore-scripts"),
      root,
      "Builder could not regenerate the destination lockfile for this new app.",
    );
    const result = await runProgram(
      input,
      inspectProjectionProgram,
      JSON.stringify({ appId, applyRoot, paths, root }),
      "Builder could not read the verified new-app registration.",
    );
    const projected = baseSchema.parse(JSON.parse(result));
    if (
      projected.appManifest !== base.appManifest ||
      projected.packageJson.content !== rootManifest ||
      projected.routes.content !== registration.proposedBytes
    ) {
      throw new Error("The app manifest or registration changed during preparation.");
    }
    const files = [
      ...projectedFile(packagePath, base.packageJson, projected.packageJson),
      ...projectedFile(routingPath, base.routes, projected.routes),
    ];
    if (base.lock.digest !== projected.lock.digest) {
      const content = await input.sandbox.readTextFile({
        path: `${relativeRoot}/${lockPath}`,
        abortSignal: input.signal,
      });
      input.signal?.throwIfAborted();
      if (content === null || digest(content) !== projected.lock.digest) {
        throw new Error("The regenerated lockfile changed during readback.");
      }
      files.push({ path: lockPath, content, digest: projected.lock.digest, mode: base.lock.mode });
    }
    return files;
  } finally {
    try {
      await input.sandbox.removePath({
        path: root.slice(workspace.length + 1),
        force: true,
        recursive: true,
      });
    } catch {
      // Scratch remains separate from the saved candidate after a cleanup failure.
    }
  }
};
