import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  createDevelopmentSnapshot,
  developmentDependencyKey,
  fingerprintDevelopmentSource,
  parseDevelopmentArguments,
  removeDevelopmentSnapshot,
} from "../lib/development/local-mode";
import {
  createDevelopmentPackage,
  developmentLaunchEnvironment,
} from "../lib/development/dev-package";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(".");
const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (value === undefined || !value.startsWith("/"))
    throw new Error(`mise must supply the absolute ${name} executable.`);
  return value;
}

async function privateRoot(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const canonical = await realpath(path);
  const info = await lstat(canonical);
  if (
    canonical !== path ||
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error(
      `Development root must be canonical, owner-only, and mode 0700: ${path}`,
    );
  return canonical;
}

async function digestOrAbsent(path: string) {
  try {
    return sha256(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

function hostPlatform() {
  if (platform() !== "darwin" && platform() !== "linux")
    throw new Error("Development mode supports macOS and Linux hosts only.");
  if (arch() === "arm64") return { oci: "linux/arm64", tag: "linux-arm64" };
  if (arch() === "x64") return { oci: "linux/amd64", tag: "linux-amd64" };
  throw new Error("Development mode supports arm64 and amd64 hosts only.");
}

async function commandSucceeded(program: string, args: string[]) {
  try {
    await execFileAsync(program, args, { cwd: repositoryRoot });
    return true;
  } catch {
    return false;
  }
}

async function runInherited(program: string, args: string[]) {
  const child = spawn(program, args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
  });
  const code = await childExit(child);
  if (code !== 0)
    throw new Error(`${basename(program)} exited with status ${code}.`);
}

async function prepareDevelopmentImage(input: {
  snapshotRoot: string;
  stateRoot: string;
  dependencyKey: string;
  ociPlatform: string;
  tagPlatform: string;
}) {
  const docker = requiredEnvironment("APP_BUILDER_DEV_DOCKER_BIN");
  const buildx = requiredEnvironment("APP_BUILDER_DEV_BUILDX_BIN");
  const msb = requiredEnvironment("APP_BUILDER_DEV_MSB_BIN");
  const toolchainDockerfile = join(
    repositoryRoot,
    "containers/eve-sandbox/dev-toolchain.Dockerfile",
  );
  const dependencyDockerfile = join(
    repositoryRoot,
    "containers/eve-sandbox/dev-dependencies.Dockerfile",
  );
  const toolchainDigest = sha256(await readFile(toolchainDockerfile));
  const toolchainTag = `app-builder-autograph-dev-toolchain:${toolchainDigest}-${input.tagPlatform}`;
  if (!(await commandSucceeded(docker, ["image", "inspect", toolchainTag]))) {
    await runInherited(buildx, [
      "build",
      "--platform",
      input.ociPlatform,
      "--file",
      toolchainDockerfile,
      "--tag",
      toolchainTag,
      "--load",
      repositoryRoot,
    ]);
  }
  const image = `app-builder-autograph-dev:${input.dependencyKey}-${input.tagPlatform}`;
  const cacheRoot = await privateRoot(
    join(input.stateRoot, "dependencies", input.dependencyKey),
  );
  const archive = join(cacheRoot, `${input.tagPlatform}.oci.tar`);
  const receiptPath = join(cacheRoot, `${input.tagPlatform}.json`);
  let reusable = false;
  try {
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
      image?: string;
      archiveSha256?: string;
    };
    reusable =
      receipt.image === image &&
      receipt.archiveSha256 === sha256(await readFile(archive));
  } catch {
    reusable = false;
  }
  if (!reusable) {
    await rm(archive, { force: true });
    await rm(receiptPath, { force: true });
    const temporary = join(
      cacheRoot,
      `.image-${process.pid}-${randomUUID()}.oci.tar`,
    );
    const lockfiles = {
      MISE_CONFIG_SHA256: await digestOrAbsent(
        join(input.snapshotRoot, ".config/mise/config.toml"),
      ),
      MISE_LOCK_SHA256: await digestOrAbsent(
        join(input.snapshotRoot, ".config/mise/mise.lock"),
      ),
      BUN_LOCK_SHA256: await digestOrAbsent(
        join(input.snapshotRoot, "bun.lock"),
      ),
      CARGO_LOCK_SHA256: await digestOrAbsent(
        join(input.snapshotRoot, "Cargo.lock"),
      ),
    };
    try {
      const buildArgs = Object.entries(lockfiles).flatMap(([name, value]) => [
        "--build-arg",
        `${name}=${value}`,
      ]);
      await runInherited(buildx, [
        "build",
        "--platform",
        input.ociPlatform,
        "--build-context",
        `arrusted-source=${input.snapshotRoot}`,
        "--build-arg",
        `TOOLCHAIN_IMAGE=${toolchainTag}`,
        "--build-arg",
        `DEPENDENCY_KEY=${input.dependencyKey}`,
        "--build-arg",
        `PLATFORM=${input.ociPlatform}`,
        ...buildArgs,
        "--file",
        dependencyDockerfile,
        "--tag",
        image,
        "--output",
        `type=oci,dest=${temporary}`,
        repositoryRoot,
      ]);
      await chmod(temporary, 0o600);
      await rename(temporary, archive);
      const receipt = {
        format: "autograph-development-dependency-image-v1",
        image,
        platform: input.ociPlatform,
        dependencyKey: input.dependencyKey,
        toolchainDockerfileSha256: toolchainDigest,
        dependencyDockerfileSha256: sha256(
          await readFile(dependencyDockerfile),
        ),
        archiveSha256: sha256(await readFile(archive)),
        lockfiles,
      };
      await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
    } finally {
      await rm(temporary, { force: true });
    }
  }
  await runInherited(msb, [
    "load",
    "--input",
    archive,
    "--tag",
    image,
    "--quiet",
  ]);
  return image;
}

function childExit(child: ChildProcess) {
  return new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
  });
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  await Promise.race([
    childExit(child),
    new Promise<void>((resolveWait) => setTimeout(resolveWait, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function sourceChanged(sourceRoot: string, expected: string) {
  while (true) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 750));
    try {
      if ((await fingerprintDevelopmentSource(sourceRoot)) !== expected)
        return true;
    } catch {
      return true;
    }
  }
}

async function supervise(input: {
  sourceRoot: string;
  runRoot: string;
  destinationRoot: string;
  image: string;
  dependencyKey: string;
  ociPlatform: string;
  nextPort: number;
  evePort: number;
}) {
  const snapshot = await createDevelopmentSnapshot({
    sourceRoot: input.sourceRoot,
    runRoot: input.runRoot,
  });
  try {
    const snapshotDependencyKey = await developmentDependencyKey({
      sourceRoot: snapshot.root,
      platform: input.ociPlatform,
      tools: {
        node: "24.18.0",
        bun: "1.3.14",
        mise: "2026.8.12",
        rust: "1.97.1",
      },
    });
    if (snapshotDependencyKey !== input.dependencyKey)
      return { kind: "changed" as const, code: 0 };
    const packageResult = await createDevelopmentPackage({
      repositoryRoot,
      outputRoot: join(input.runRoot, "codex"),
      port: input.nextPort,
    });
    const closed = developmentLaunchEnvironment({
      snapshotRoot: snapshot.root,
      destinationRoot: input.destinationRoot,
      image: input.image,
      fingerprint: snapshot.fingerprint,
      dependencyKey: input.dependencyKey,
      evePort: input.evePort,
    });
    const baseEnvironment = {
      NODE_ENV: "production" as const,
      PATH: "/usr/bin:/bin",
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      LANG: process.env.LANG ?? "C",
      LC_ALL: process.env.LC_ALL ?? "C",
      ...closed,
      APP_BUILDER_EVE_PORT: String(input.evePort),
    };
    const node = requiredEnvironment("APP_BUILDER_DEV_NODE_BIN");
    const launcher = join(
      repositoryRoot,
      ".config/mise/scripts/trusted-node-launcher",
    );
    const eve = spawn(
      launcher,
      [
        node,
        join(repositoryRoot, "node_modules/eve/bin/eve.js"),
        "dev",
        "--host",
        "127.0.0.1",
        "--port",
        String(input.evePort),
        "--no-ui",
      ],
      {
        cwd: repositoryRoot,
        env: baseEnvironment,
        stdio: "inherit",
      },
    );
    const next = spawn(
      launcher,
      [
        node,
        join(repositoryRoot, "node_modules/next/dist/bin/next"),
        "dev",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(input.nextPort),
      ],
      {
        cwd: repositoryRoot,
        env: { ...baseEnvironment, NODE_ENV: "development" },
        stdio: "inherit",
      },
    );
    console.log(
      `Autograph development is ready at http://127.0.0.1:${input.nextPort}.`,
    );
    console.log(`Codex development package: ${packageResult.pluginRoot}`);
    const outcome = await Promise.race([
      sourceChanged(input.sourceRoot, snapshot.fingerprint).then(() => ({
        kind: "changed" as const,
        code: 0,
      })),
      childExit(eve).then((code) => ({ kind: "exit" as const, code })),
      childExit(next).then((code) => ({ kind: "exit" as const, code })),
    ]);
    await Promise.all([stop(eve), stop(next)]);
    return outcome;
  } finally {
    await removeDevelopmentSnapshot(input.runRoot);
  }
}

const args = parseDevelopmentArguments(process.argv.slice(2));
const sourceRoot = await realpath(args.arrustedRoot);
const artifactRoot = await privateRoot(
  args.stateRoot ?? join(repositoryRoot, ".artifacts/development"),
);
const stateRoot = await privateRoot(join(artifactRoot, "state"));
const destinationRoot = await privateRoot(
  args.destinationRoot ?? join(artifactRoot, "destination"),
);
const selectedPlatform = hostPlatform();
const tools = {
  node: "24.18.0",
  bun: "1.3.14",
  mise: "2026.8.12",
  rust: "1.97.1",
} as const;

while (true) {
  const dependencyKey = await developmentDependencyKey({
    sourceRoot,
    platform: selectedPlatform.oci,
    tools,
  });
  const runParent = await privateRoot(join(stateRoot, "runs"));
  const runRoot = await realpath(await mkdtemp(join(runParent, "run-")));
  await chmod(runRoot, 0o700);
  const snapshot = await createDevelopmentSnapshot({ sourceRoot, runRoot });
  let image: string;
  try {
    image = await prepareDevelopmentImage({
      snapshotRoot: snapshot.root,
      stateRoot,
      dependencyKey,
      ociPlatform: selectedPlatform.oci,
      tagPlatform: selectedPlatform.tag,
    });
  } finally {
    await removeDevelopmentSnapshot(runRoot);
  }
  const activeRun = await realpath(await mkdtemp(join(runParent, "run-")));
  await chmod(activeRun, 0o700);
  const outcome = await supervise({
    sourceRoot,
    runRoot: activeRun,
    destinationRoot,
    image,
    dependencyKey,
    ociPlatform: selectedPlatform.oci,
    nextPort: args.nextPort,
    evePort: args.evePort,
  });
  if (outcome.kind === "exit") process.exit(outcome.code);
  console.log(
    "Arrusted source changed; the prior snapshot was invalidated and development is restarting.",
  );
}
