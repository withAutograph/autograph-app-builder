import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import {
  HOSTED_BUN_VERSION,
  HOSTED_MISE_VERSION,
  HOSTED_NODE_VERSION,
  HOSTED_RUST_VERSION,
  HOSTED_TOOLCHAIN_DOWNLOAD_HOSTS,
  hostedToolchainArtifacts,
} from "./hosted-toolchain";

const sha256Pattern = /^[0-9a-f]{64}$/u;
const gitObjectPattern = /^[0-9a-f]{40}$/u;
const dependencyInputs = [
  ".config/mise/config.toml",
  ".config/mise/mise.lock",
  "bun.lock",
  "Cargo.lock",
] as const;

export const DEVELOPMENT_SOURCE_ARCHIVE_PATH =
  ".app-builder/development-source.tar.gz";
export const DEVELOPMENT_SANDBOX_DOWNLOAD_HOSTS = [
  ...HOSTED_TOOLCHAIN_DOWNLOAD_HOSTS,
  "index.crates.io",
  "registry.npmjs.org",
  "static.crates.io",
] as const;
export const DEVELOPMENT_SANDBOX_ENVIRONMENT = {
  CARGO_HOME: "/workspace/.app-builder/toolchain/cargo-home",
  CARGO_NET_OFFLINE: "true",
  MISE_AUTO_INSTALL: "false",
  MISE_DATA_DIR: "/workspace/.app-builder/toolchain/mise-data",
  MISE_EXEC_AUTO_INSTALL: "false",
  MISE_TASK_RUN_AUTO_INSTALL: "false",
  PATH: "/workspace/.app-builder/toolchain/bin:/workspace/.app-builder/toolchain/rust/bin:/usr/bin:/bin",
} as const;

type Environment = Readonly<Record<string, string | undefined>>;

export type DevelopmentVercelBootstrapInput = Readonly<{
  sourceRoot: string;
  sourceFingerprint: string;
  sourceSha: string;
  sourceTree: string;
  dependencyKey: string;
  sourceArchive: Buffer;
  sourceArchiveSha256: string;
  lockfiles: Readonly<Record<(typeof dependencyInputs)[number], string>>;
}>;

const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
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

function git(sourceRoot: string, args: readonly string[]) {
  return execFileSync(
    "/usr/bin/git",
    ["-c", "core.hooksPath=/dev/null", "-C", sourceRoot, ...args],
    { encoding: "utf8", env: gitEnvironment() },
  ).trim();
}

function required(environment: Environment, name: string) {
  const value = environment[name];
  if (value === undefined || value.length === 0)
    throw new Error(`Development Vercel Sandbox ${name} was unavailable.`);
  return value;
}

function exactSourceRoot(path: string) {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    realpathSync(path) !== path
  )
    throw new Error("Development Vercel source root was not canonical.");
  const info = lstatSync(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o022) !== 0
  )
    throw new Error("Development Vercel source root was not owner-bound.");
  return path;
}

function digestFileOrAbsent(path: string) {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`Development dependency input was invalid: ${path}`);
    return sha256(readFileSync(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

function assertInput(input: DevelopmentVercelBootstrapInput) {
  if (
    !sha256Pattern.test(input.sourceFingerprint) ||
    !sha256Pattern.test(input.dependencyKey) ||
    !gitObjectPattern.test(input.sourceSha) ||
    !gitObjectPattern.test(input.sourceTree) ||
    !sha256Pattern.test(input.sourceArchiveSha256) ||
    sha256(input.sourceArchive) !== input.sourceArchiveSha256 ||
    Object.values(input.lockfiles).some(
      (digest) => digest !== "absent" && !sha256Pattern.test(digest),
    )
  )
    throw new Error("Development Vercel bootstrap identity was invalid.");
}

/**
 * Makes Bun's installed dependency links portable before the closure is
 * archived. Links into node_modules stay relative to that closure. Workspace
 * links are rebound to an explicit immutable source root when one is supplied,
 * or to the fixed sandbox repository path for the legacy development archive.
 * Everything else is rejected rather than producing a cache that will fail
 * later.
 */
export const developmentDependencySymlinkScript = String.raw`const fs = require("node:fs");
const path = require("node:path");

const sourceRoot = fs.realpathSync(process.argv[2]);
const requestedWorkspaceRoot = process.argv[3];
if (requestedWorkspaceRoot !== undefined && !path.isAbsolute(requestedWorkspaceRoot))
  throw new Error("Development workspace dependency root must be absolute.");
const workspaceRoot = requestedWorkspaceRoot === undefined
  ? "/workspace/repository"
  : fs.realpathSync(requestedWorkspaceRoot);
const modulesRoot = fs.realpathSync(path.join(sourceRoot, "node_modules"));
const contains = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(".." + path.sep))
  );
};

const directories = [modulesRoot];
const links = [];
while (directories.length > 0) {
  const directory = directories.pop();
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const link = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      directories.push(link);
      continue;
    }
    if (entry.isSymbolicLink()) links.push(link);
  }
}

const replacements = [];
for (const link of links) {
  let target;
  try {
    target = fs.realpathSync(link);
  } catch {
    throw new Error(
      "Unresolved development dependency link: " +
        path.relative(modulesRoot, link),
    );
  }

  let replacement;
  if (contains(modulesRoot, target)) {
    replacement = path.relative(path.dirname(link), target) || ".";
    if (path.isAbsolute(replacement))
      throw new Error("Development dependency link was not portable.");
  } else if (contains(sourceRoot, target)) {
    const sourceRelative = path.relative(sourceRoot, target);
    replacement =
      workspaceRoot +
      (sourceRelative === ""
        ? ""
        : "/" + sourceRelative.split(path.sep).join("/"));
  } else {
    throw new Error(
      "Development dependency link escaped the source: " +
        path.relative(modulesRoot, link),
    );
  }

  replacements.push({ link, replacement });
}
for (const { link, replacement } of replacements) {
  fs.unlinkSync(link);
  fs.symlinkSync(replacement, link);
}`;

const developmentToolchainCase = (
  architecture: keyof typeof hostedToolchainArtifacts,
) => {
  const artifact = hostedToolchainArtifacts[architecture];
  return `${architecture})
    mise_url='${artifact.miseUrl}'
    mise_sha='${artifact.miseSha256}'
    bun_url='${artifact.bunUrl}'
    bun_sha='${artifact.bunSha256}'
    bun_directory='${artifact.bunDirectory}'
    node_url='${artifact.nodeUrl}'
    node_sha='${artifact.nodeSha256}'
    node_directory='${artifact.nodeDirectory}'
    cargo_url='${artifact.rust.cargoUrl}'
    cargo_sha='${artifact.rust.cargoSha256}'
    cargo_directory='${artifact.rust.cargoDirectory}'
    rustc_url='${artifact.rust.rustcUrl}'
    rustc_sha='${artifact.rust.rustcSha256}'
    rustc_directory='${artifact.rust.rustcDirectory}'
    rust_std_url='${artifact.rust.stdUrl}'
    rust_std_sha='${artifact.rust.stdSha256}'
    rust_std_directory='${artifact.rust.stdDirectory}'
    ;;`;
};

/** Installs exact tools inside the disposable template, never on the host. */
export function developmentPinnedToolchainCommand() {
  return `set -euo pipefail
case "$(uname -m)" in
  ${developmentToolchainCase("aarch64")}
  ${developmentToolchainCase("x86_64")}
  *) echo 'unsupported Vercel Sandbox architecture' >&2; exit 1 ;;
esac
command -v curl >/dev/null
command -v python3 >/dev/null
command -v sha256sum >/dev/null
command -v tar >/dev/null
command -v unzip >/dev/null
extract_verified_archive() {
  python3 - "$1" "$2" <<'PY'
import pathlib
import sys
import tarfile

archive_path = sys.argv[1]
destination = pathlib.Path(sys.argv[2]).resolve()
destination.mkdir(parents=True, exist_ok=True)
with tarfile.open(archive_path, "r:*") as archive:
    for member in archive.getmembers():
        member_path = pathlib.PurePosixPath(member.name)
        if member_path.is_absolute() or ".." in member_path.parts:
            raise SystemExit("unsafe archive path")
        if not (member.isdir() or member.isfile() or member.issym() or member.islnk()):
            raise SystemExit("unsupported archive entry")
    archive.extractall(destination, filter="data")
PY
}
work="$(mktemp -d /tmp/app-builder-development-toolchain.XXXXXX)"
root='/workspace/.app-builder/toolchain'
stage='download'
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then printf 'development_toolchain_failed:%s\n' "$stage" >&2; fi
  find "$work" -depth -delete 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT
install -d -m 0755 "$root/bin" "$root/rust"
curl --fail --location --silent --show-error "$mise_url" --output "$work/mise"
printf '%s  %s\n' "$mise_sha" "$work/mise" | sha256sum --check --strict
curl --fail --location --silent --show-error "$bun_url" --output "$work/bun.zip"
printf '%s  %s\n' "$bun_sha" "$work/bun.zip" | sha256sum --check --strict
curl --fail --location --silent --show-error "$node_url" --output "$work/node.tar.gz"
printf '%s  %s\n' "$node_sha" "$work/node.tar.gz" | sha256sum --check --strict
curl --fail --location --silent --show-error "$cargo_url" --output "$work/cargo.tar.xz"
printf '%s  %s\n' "$cargo_sha" "$work/cargo.tar.xz" | sha256sum --check --strict
curl --fail --location --silent --show-error "$rustc_url" --output "$work/rustc.tar.xz"
printf '%s  %s\n' "$rustc_sha" "$work/rustc.tar.xz" | sha256sum --check --strict
curl --fail --location --silent --show-error "$rust_std_url" --output "$work/rust-std.tar.xz"
printf '%s  %s\n' "$rust_std_sha" "$work/rust-std.tar.xz" | sha256sum --check --strict
stage='installation'
install -m 0755 "$work/mise" "$root/bin/mise"
unzip -q "$work/bun.zip" -d "$work"
install -m 0755 "$work/$bun_directory/bun" "$root/bin/bun"
extract_verified_archive "$work/node.tar.gz" "$work"
install -m 0755 "$work/$node_directory/bin/node" "$root/bin/node"
extract_verified_archive "$work/cargo.tar.xz" "$work"
extract_verified_archive "$work/rustc.tar.xz" "$work"
extract_verified_archive "$work/rust-std.tar.xz" "$work"
"$work/$cargo_directory/install.sh" --prefix="$root/rust" --disable-ldconfig
"$work/$rustc_directory/install.sh" --prefix="$root/rust" --disable-ldconfig
"$work/$rust_std_directory/install.sh" --prefix="$root/rust" --disable-ldconfig
stage='readback'
PATH="$root/bin:$root/rust/bin:/usr/bin:/bin"
export PATH
mise --version | grep -E '^2026[.]8[.]12($| )'
bun --version | grep -E '^1[.]3[.]14$'
node --version | grep -E '^v24[.]18[.]0$'
cargo --version | grep -E '^cargo 1[.]97[.]1 '
rustc --version | grep -E '^rustc 1[.]97[.]1 '`;
}

export function developmentPinnedToolchainKey() {
  return sha256(
    JSON.stringify({
      contractVersion: 1,
      node: HOSTED_NODE_VERSION,
      bun: HOSTED_BUN_VERSION,
      mise: HOSTED_MISE_VERSION,
      rust: HOSTED_RUST_VERSION,
      artifacts: hostedToolchainArtifacts,
      downloadHosts: HOSTED_TOOLCHAIN_DOWNLOAD_HOSTS,
      command: developmentPinnedToolchainCommand(),
    }),
  );
}

/** Reads only the exact transient Arrusted snapshot selected by `mise run dev`. */
export function readDevelopmentVercelBootstrapInput(
  environment: Environment = process.env,
): DevelopmentVercelBootstrapInput {
  if (
    environment.APP_BUILDER_EXECUTION_MODE !== "development" ||
    environment.APP_BUILDER_SANDBOX_PROVIDER !== "vercel" ||
    environment.APP_BUILDER_EXECUTION_BUNDLE !== "local-development"
  )
    throw new Error("Development Vercel Sandbox binding was not closed.");
  const sourceRoot = exactSourceRoot(
    required(environment, "REPOSITORY_LOCAL_ROOTS"),
  );
  const result = {
    sourceRoot,
    sourceFingerprint: required(
      environment,
      "APP_BUILDER_DEVELOPMENT_SOURCE_FINGERPRINT",
    ),
    sourceSha: required(environment, "APP_BUILDER_DEVELOPMENT_SOURCE_SHA"),
    sourceTree: required(environment, "APP_BUILDER_DEVELOPMENT_SOURCE_TREE"),
    dependencyKey: required(
      environment,
      "APP_BUILDER_DEVELOPMENT_DEPENDENCY_KEY",
    ),
    lockfiles: Object.fromEntries(
      dependencyInputs.map((path) => [
        path,
        digestFileOrAbsent(join(sourceRoot, path)),
      ]),
    ) as Record<(typeof dependencyInputs)[number], string>,
  };
  if (
    git(sourceRoot, ["rev-parse", "HEAD"]) !== result.sourceSha ||
    git(sourceRoot, ["rev-parse", "HEAD^{tree}"]) !== result.sourceTree ||
    git(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]) !==
      ""
  )
    throw new Error("Development Vercel source snapshot drifted.");
  const sourceArchive = execFileSync(
    "/usr/bin/git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      sourceRoot,
      "archive",
      "--format=tar.gz",
      result.sourceSha,
    ],
    { env: gitEnvironment(), maxBuffer: 256 * 1024 * 1024 },
  );
  const input = {
    ...result,
    sourceArchive,
    sourceArchiveSha256: sha256(sourceArchive),
  };
  assertInput(input);
  return input;
}

/** Builds the standard development-execution cache once per dependency key. */
export function developmentVercelDependencyCommand(
  input: DevelopmentVercelBootstrapInput,
) {
  assertInput(input);
  return `set -euo pipefail
test "$(uname -m)" = x86_64
source_archive='/workspace/${DEVELOPMENT_SOURCE_ARCHIVE_PATH}'
printf '%s  %s\n' '${input.sourceArchiveSha256}' "$source_archive" | sha256sum --check --strict
work="$(mktemp -d /tmp/app-builder-development.XXXXXX)"
stage='source-staging'
cleanup() { status=$?; if [ "$status" -ne 0 ]; then printf 'development_vercel_bootstrap_failed:%s\n' "$stage" >&2; fi; find "$work" -depth -delete 2>/dev/null || true; exit "$status"; }
trap cleanup EXIT
install -d -m 0755 "$work/source"
tar --extract --gzip --file "$source_archive" --directory "$work/source" --no-same-owner --no-same-permissions
unlink "$source_archive"
cd "$work/source"
stage='javascript-install'
bun install --frozen-lockfile --ignore-scripts --linker=hoisted --silent
test -d node_modules && test ! -L node_modules
node -e 'const fs=require("node:fs");const read=(p)=>JSON.parse(fs.readFileSync(p,"utf8")).version;if(read("node_modules/path-to-regexp/package.json")!=="8.4.2"||read("node_modules/@vercel/microfrontends/package.json")!=="2.4.0"||read("node_modules/@vercel/microfrontends/node_modules/path-to-regexp/package.json")!=="6.3.0")process.exit(1)'
node - "$work/source" <<'NODE'
${developmentDependencySymlinkScript}
NODE
stage='rust-install'
install -d -m 0755 "$work/cargo-closure/vendor"
CARGO_NET_OFFLINE=false cargo vendor --locked --versioned-dirs "$work/cargo-closure/vendor" > "$work/cargo-closure/config.toml"
sed -i "s#$work/cargo-closure/vendor#/opt/app-builder/cargo/vendor#g" "$work/cargo-closure/config.toml"
grep -F 'directory = "/opt/app-builder/cargo/vendor"' "$work/cargo-closure/config.toml" >/dev/null
if grep -F "$work" "$work/cargo-closure/config.toml" >/dev/null; then exit 1; fi
printf '\n[net]\noffline = true\n' >> "$work/cargo-closure/config.toml"
stage='archive'
tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner --format=posix --pax-option=delete=atime,delete=ctime --create --file - node_modules | gzip --no-name --best > "$work/node-modules.tar.gz"
tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner --format=posix --pax-option=delete=atime,delete=ctime --create --file - --directory "$work/cargo-closure" config.toml vendor | gzip --no-name --best > "$work/cargo-closure.tar.gz"
archive_sha="$(sha256sum "$work/node-modules.tar.gz" | cut -d' ' -f1)"
archive_bytes="$(stat --format='%s' "$work/node-modules.tar.gz")"
cargo_sha="$(sha256sum "$work/cargo-closure.tar.gz" | cut -d' ' -f1)"
cargo_bytes="$(stat --format='%s' "$work/cargo-closure.tar.gz")"
cat > "$work/manifest.json" <<'JSON'
{"version":2,"scope":"development-execution","platform":"linux/amd64","dependencyKey":"${input.dependencyKey}","lockfiles":{".config/mise/config.toml":"${input.lockfiles[".config/mise/config.toml"]}",".config/mise/mise.lock":"${input.lockfiles[".config/mise/mise.lock"]}","bun.lock":"${input.lockfiles["bun.lock"]}","Cargo.lock":"${input.lockfiles["Cargo.lock"]}"},"runtime":{"node":"${HOSTED_NODE_VERSION}","bun":"${HOSTED_BUN_VERSION}","mise":"${HOSTED_MISE_VERSION}","rust":"${HOSTED_RUST_VERSION}"},"closure":{"package":"@vercel/microfrontends","version":"2.4.0","archivePath":"/opt/app-builder/dependency-cache/node-modules.tar.gz","archiveSha256":"ARCHIVE_SHA","archiveBytes":ARCHIVE_BYTES,"cargoArchivePath":"/opt/app-builder/dependency-cache/cargo-closure.tar.gz","cargoArchiveSha256":"CARGO_SHA","cargoArchiveBytes":CARGO_BYTES}}
JSON
sed -i "s/ARCHIVE_SHA/$archive_sha/g;s/ARCHIVE_BYTES/$archive_bytes/g;s/CARGO_SHA/$cargo_sha/g;s/CARGO_BYTES/$cargo_bytes/g" "$work/manifest.json"
stage='cache-installation'
sudo install -d -m 0755 /opt/app-builder/dependency-cache "/opt/app-builder/dependencies/$archive_sha" /opt/app-builder/cargo
sudo install -m 0444 "$work/manifest.json" /opt/app-builder/dependency-cache/manifest.json
sudo install -m 0444 "$work/node-modules.tar.gz" /opt/app-builder/dependency-cache/node-modules.tar.gz
sudo install -m 0444 "$work/cargo-closure.tar.gz" /opt/app-builder/dependency-cache/cargo-closure.tar.gz
sudo tar --extract --gzip --file "$work/node-modules.tar.gz" --directory "/opt/app-builder/dependencies/$archive_sha" --no-same-owner --no-same-permissions
sudo tar --extract --gzip --file "$work/cargo-closure.tar.gz" --directory /opt/app-builder/cargo --no-same-owner --no-same-permissions
sudo chmod -R a-w,a+rX /opt/app-builder/dependency-cache "/opt/app-builder/dependencies/$archive_sha" /opt/app-builder/cargo
printf '%s\n' 'development_vercel_bootstrap_ready:${input.dependencyKey}'`;
}

/** Agent and skill edits may change Eve's authored key; the provider key may not. */
export function developmentVercelProviderTemplateKey(dependencyKey: string) {
  if (!sha256Pattern.test(dependencyKey))
    throw new Error("Development dependency key was invalid.");
  return `app-builder-development-${dependencyKey}`;
}

export function developmentVercelRevalidationKey(
  input: DevelopmentVercelBootstrapInput,
) {
  assertInput(input);
  return `autograph-app-builder-vercel-development-v1:${sha256(
    JSON.stringify({
      contractVersion: 1,
      dependencyKey: input.dependencyKey,
      pinnedToolchain: developmentPinnedToolchainKey(),
      downloadHosts: DEVELOPMENT_SANDBOX_DOWNLOAD_HOSTS,
    }),
  )}`;
}

export function developmentExecutionArtifactDigest(
  environment: Environment = process.env,
) {
  if (
    environment.APP_BUILDER_EXECUTION_MODE !== "development" ||
    environment.APP_BUILDER_SANDBOX_PROVIDER !== "vercel" ||
    environment.APP_BUILDER_EXECUTION_BUNDLE !== "local-development"
  )
    throw new Error("Development execution binding was not closed.");
  const sourceFingerprint = required(
    environment,
    "APP_BUILDER_DEVELOPMENT_SOURCE_FINGERPRINT",
  );
  const dependencyKey = required(
    environment,
    "APP_BUILDER_DEVELOPMENT_DEPENDENCY_KEY",
  );
  if (
    !sha256Pattern.test(sourceFingerprint) ||
    !sha256Pattern.test(dependencyKey)
  )
    throw new Error("Development execution identity was invalid.");
  return `vercel-sandbox-development@sha256:${sha256(
    JSON.stringify({ version: 1, sourceFingerprint, dependencyKey }),
  )}`;
}
