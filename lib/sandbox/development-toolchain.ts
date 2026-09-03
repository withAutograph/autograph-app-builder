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
/** Development cache state belongs to the local builder and remains writable. */
export const DEVELOPMENT_DEPENDENCY_CACHE_ROOT =
  "/workspace/.app-builder/dependency-cache";
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
  LD_LIBRARY_PATH: "/workspace/.app-builder/toolchain/rust/lib",
  PATH: "/workspace/.app-builder/toolchain/bin:/workspace/.app-builder/toolchain/rust/bin:/usr/bin:/bin",
  TERM: "xterm-256color",
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
LD_LIBRARY_PATH="$root/rust/lib"
export LD_LIBRARY_PATH
TERM='xterm-256color'
export TERM
mise --version | grep -E '^2026[.]8[.]12($| )'
bun --version | grep -E '^1[.]3[.]14$'
node --version | grep -E '^v24[.]18[.]0$'
cargo --version | grep -E '^cargo 1[.]97[.]1 '
rustc --version | grep -E '^rustc 1[.]97[.]1 '
trap - EXIT
find "$work" -depth -delete 2>/dev/null || true
printf '%s\n' 'development_toolchain_ready'
exit 0`;
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
cache_root='${DEVELOPMENT_DEPENDENCY_CACHE_ROOT}'
cache_dependencies="$cache_root/dependencies/${input.dependencyKey}"
if node - "$cache_root/manifest.json" "$cache_dependencies" "$cache_root" <<'NODE'
const fs = require("node:fs");
const [manifestPath, dependencies, cacheRoot] = process.argv.slice(2);
const expected = {
  version: 3,
  scope: "development-execution",
  platform: "linux/amd64",
  dependencyKey: "${input.dependencyKey}",
  lockfiles: {".config/mise/config.toml":"${input.lockfiles[".config/mise/config.toml"]}",".config/mise/mise.lock":"${input.lockfiles[".config/mise/mise.lock"]}","bun.lock":"${input.lockfiles["bun.lock"]}","Cargo.lock":"${input.lockfiles["Cargo.lock"]}"},
  runtime: {node:"${HOSTED_NODE_VERSION}",bun:"${HOSTED_BUN_VERSION}",mise:"${HOSTED_MISE_VERSION}",rust:"${HOSTED_RUST_VERSION}"},
  closure: {package:"@vercel/microfrontends",version:"2.4.0",contentDigest:"${input.dependencyKey}",nodeModulesPath:"${DEVELOPMENT_DEPENDENCY_CACHE_ROOT}/dependencies/${input.dependencyKey}/node_modules",cargoConfigPath:"${DEVELOPMENT_DEPENDENCY_CACHE_ROOT}/cargo/config.toml"},
};
const safe = (path, kind) => {
  const entry = fs.lstatSync(path);
  return !entry.isSymbolicLink() && (kind === "directory" ? entry.isDirectory() : entry.isFile()) && (entry.mode & 0o022) === 0;
};
try {
  const actual = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const required = [
    [manifestPath, "file"],
    [dependencies, "directory"],
    [dependencies + "/node_modules", "directory"],
    [dependencies + "/node_modules/path-to-regexp/package.json", "file"],
    [dependencies + "/node_modules/@vercel/microfrontends/package.json", "file"],
    [dependencies + "/node_modules/@vercel/microfrontends/node_modules/path-to-regexp/package.json", "file"],
    [cacheRoot + "/cargo/vendor", "directory"],
    [cacheRoot + "/cargo/config.toml", "file"],
  ];
  if (JSON.stringify(actual) !== JSON.stringify(expected) || !required.every(([path, kind]) => safe(path, kind))) process.exit(1);
} catch { process.exit(1); }
NODE
then
  unlink "$source_archive"
  printf '%s\n' 'development_vercel_dependency_cache_hit:${input.dependencyKey}'
  exit 0
fi
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
sed -i "s#$work/cargo-closure/vendor#${DEVELOPMENT_DEPENDENCY_CACHE_ROOT}/cargo/vendor#g" "$work/cargo-closure/config.toml"
grep -F 'directory = "${DEVELOPMENT_DEPENDENCY_CACHE_ROOT}/cargo/vendor"' "$work/cargo-closure/config.toml" >/dev/null
if grep -F "$work" "$work/cargo-closure/config.toml" >/dev/null; then exit 1; fi
printf '\n[net]\noffline = true\n' >> "$work/cargo-closure/config.toml"
stage='cache-installation'
install -d -m 0755 "$cache_root"
test "$(realpath "$cache_root")" = "$cache_root"
rm -rf "$cache_dependencies" "$cache_root/cargo"
install -d -m 0755 "$cache_dependencies" "$cache_root/cargo"
mv node_modules "$cache_dependencies/node_modules"
mv "$work/cargo-closure/vendor" "$cache_root/cargo/vendor"
install -m 0644 "$work/cargo-closure/config.toml" "$cache_root/cargo/config.toml"
chmod -R u+rwX,go-w "$cache_dependencies" "$cache_root/cargo"
cat > "$work/manifest.json" <<'JSON'
{"version":3,"scope":"development-execution","platform":"linux/amd64","dependencyKey":"${input.dependencyKey}","lockfiles":{".config/mise/config.toml":"${input.lockfiles[".config/mise/config.toml"]}",".config/mise/mise.lock":"${input.lockfiles[".config/mise/mise.lock"]}","bun.lock":"${input.lockfiles["bun.lock"]}","Cargo.lock":"${input.lockfiles["Cargo.lock"]}"},"runtime":{"node":"${HOSTED_NODE_VERSION}","bun":"${HOSTED_BUN_VERSION}","mise":"${HOSTED_MISE_VERSION}","rust":"${HOSTED_RUST_VERSION}"},"closure":{"package":"@vercel/microfrontends","version":"2.4.0","contentDigest":"${input.dependencyKey}","nodeModulesPath":"${DEVELOPMENT_DEPENDENCY_CACHE_ROOT}/dependencies/${input.dependencyKey}/node_modules","cargoConfigPath":"${DEVELOPMENT_DEPENDENCY_CACHE_ROOT}/cargo/config.toml"}}
JSON
install -m 0644 "$work/manifest.json" "$cache_root/manifest.json"
if find "$cache_root" \\( -type f -o -type d \\) -perm /022 -print -quit | grep -q .; then exit 1; fi
printf '%s\n' 'development_vercel_bootstrap_ready:${input.dependencyKey}'`;
}

/**
 * Repairs a partially provisioned development template in place.  Vercel may
 * retain a provider template created before its dependency closure was
 * written; that is a cache miss, not a reason to make the first planning turn
 * fail.  This deliberately stages dependencies away from the prepared source
 * tree, then installs the same reusable development cache that template
 * bootstrap creates.
 */
export function developmentVercelDependencyRepairCommand(
  dependencyKey: string,
) {
  if (!sha256Pattern.test(dependencyKey))
    throw new Error("Development dependency key was invalid.");
  return `set -euo pipefail
test "$(uname -m)" = x86_64
source_root='/workspace/repository'
test -d "$source_root"
lockfiles="$(node - "$source_root" '${dependencyKey}' <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const expected = process.argv[3];
const paths = [".config/mise/config.toml", ".config/mise/mise.lock", "bun.lock", "Cargo.lock"];
const digest = (file) => {
  try { return crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex"); }
  catch (error) { if (error.code === "ENOENT") return "absent"; throw error; }
};
const lockfiles = Object.fromEntries(paths.map((file) => [file, digest(file)]));
const actual = crypto.createHash("sha256").update(JSON.stringify({
  version: 2,
  platform: "linux/amd64",
  tools: { node: "${HOSTED_NODE_VERSION}", bun: "${HOSTED_BUN_VERSION}", mise: "${HOSTED_MISE_VERSION}", rust: "${HOSTED_RUST_VERSION}" },
  lockfiles,
})).digest("hex");
if (actual !== expected) process.exit(1);
process.stdout.write(JSON.stringify(lockfiles));
NODE
)"
work="$(mktemp -d /tmp/app-builder-development-repair.XXXXXX)"
stage='source-staging'
heartbeat() { while :; do printf 'development_vercel_repair_progress:%s\n' "$stage" >&2; sleep 15; done; }
heartbeat &
heartbeat_pid=$!
cleanup() { status=$?; kill "$heartbeat_pid" 2>/dev/null || true; wait "$heartbeat_pid" 2>/dev/null || true; if [ "$status" -ne 0 ]; then printf 'development_vercel_repair_failed:%s\n' "$stage" >&2; fi; find "$work" -depth -delete 2>/dev/null || true; exit "$status"; }
trap cleanup EXIT
install -d -m 0755 "$work/source"
tar --create --directory "$source_root" --exclude='./.git' --exclude='./node_modules' --exclude='./.app-builder' --file - . | tar --extract --file - --directory "$work/source" --no-same-owner --no-same-permissions
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
sed -i "s#$work/cargo-closure/vendor#${DEVELOPMENT_DEPENDENCY_CACHE_ROOT}/cargo/vendor#g" "$work/cargo-closure/config.toml"
grep -F 'directory = "${DEVELOPMENT_DEPENDENCY_CACHE_ROOT}/cargo/vendor"' "$work/cargo-closure/config.toml" >/dev/null
if grep -F "$work" "$work/cargo-closure/config.toml" >/dev/null; then exit 1; fi
printf '\n[net]\noffline = true\n' >> "$work/cargo-closure/config.toml"
stage='cache-installation'
cache_root='${DEVELOPMENT_DEPENDENCY_CACHE_ROOT}'
cache_dependencies="$cache_root/dependencies/${dependencyKey}"
install -d -m 0755 "$cache_root"
test "$(realpath "$cache_root")" = "$cache_root"
rm -rf "$cache_dependencies" "$cache_root/cargo"
install -d -m 0755 "$cache_dependencies" "$cache_root/cargo"
mv node_modules "$cache_dependencies/node_modules"
mv "$work/cargo-closure/vendor" "$cache_root/cargo/vendor"
install -m 0644 "$work/cargo-closure/config.toml" "$cache_root/cargo/config.toml"
chmod -R u+rwX,go-w "$cache_dependencies" "$cache_root/cargo"
cat > "$work/manifest.json" <<JSON
{"version":3,"scope":"development-execution","platform":"linux/amd64","dependencyKey":"${dependencyKey}","lockfiles":$lockfiles,"runtime":{"node":"${HOSTED_NODE_VERSION}","bun":"${HOSTED_BUN_VERSION}","mise":"${HOSTED_MISE_VERSION}","rust":"${HOSTED_RUST_VERSION}"},"closure":{"package":"@vercel/microfrontends","version":"2.4.0","contentDigest":"${dependencyKey}","nodeModulesPath":"${DEVELOPMENT_DEPENDENCY_CACHE_ROOT}/dependencies/${dependencyKey}/node_modules","cargoConfigPath":"${DEVELOPMENT_DEPENDENCY_CACHE_ROOT}/cargo/config.toml"}}
JSON
if find "$cache_root" \\( -type f -o -type d \\) -perm /022 -print -quit | grep -q .; then exit 1; fi
install -m 0644 "$work/manifest.json" "$cache_root/manifest.json"
printf '%s\n' 'development_vercel_repair_ready:${dependencyKey}'`;
}

/** Agent and skill edits may change Eve's authored key; the provider key may not. */
export function developmentVercelProviderTemplateKey(dependencyKey: string) {
  if (!sha256Pattern.test(dependencyKey))
    throw new Error("Development dependency key was invalid.");
  return `app-builder-development-${dependencyKey}`;
}

export function developmentVercelRevalidationKey(
  input: Pick<DevelopmentVercelBootstrapInput, "dependencyKey">,
) {
  if (!sha256Pattern.test(input.dependencyKey))
    throw new Error("Development dependency key was invalid.");
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
