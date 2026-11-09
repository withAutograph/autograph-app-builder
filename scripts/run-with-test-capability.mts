import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";

import {
  createEveEvalRuntimeDirectories,
  waitForEveEvalChild,
} from "../lib/testing/eve-eval-lifecycle";

const testExecutablePath = "/usr/bin:/bin";

const MODE_MASK = 18;
const ZERO = 0;
const ONE = 1;

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const repositoryRootStat = statSync(repositoryRoot, { bigint: true });
const invalidRootPath =
  !path.isAbsolute(repositoryRoot) || realpathSync(repositoryRoot) !== repositoryRoot;
if (
  invalidRootPath ||
  !repositoryRootStat.isDirectory() ||
  repositoryRootStat.uid !== BigInt(process.getuid?.() ?? -1) ||
  // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
  (repositoryRootStat.mode & BigInt(MODE_MASK)) !== BigInt(ZERO)
) {
  throw new Error("The structural test package root was not owner-bound.");
}
const preload = pathToFileURL(
  path.resolve(repositoryRoot, "scripts/test-capability-preload.mjs"),
).href;
const evalFetchPreload = pathToFileURL(
  path.resolve(repositoryRoot, "scripts/eve-eval-fetch-preload.mjs"),
).href;
const maximumFrameBytes = 4096;
const launcher = path.resolve(repositoryRoot, ".config/mise/scripts/trusted-node-launcher");
const allowedEnvironment = [
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TZ",
  "CI",
  "NO_COLOR",
  "FORCE_COLOR",
  "NODE_ENV",
  "VERCEL_OIDC_TOKEN",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
  "APP_BUILDER_EVAL_BROWSER_EXECUTABLE",
  "ARRUSTED_MANAGED_RUNTIME_TEST_ROOT",
  "BUN_BINARY",
  "APP_BUILDER_DEV_MISE_BIN",
] as const;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function childEnvironment() {
  const environment = new Map<string, string>([["PATH", testExecutablePath]]);
  for (const name of allowedEnvironment) {
    const value = process.env[name];
    if (value !== undefined) {
      environment.set(name, value);
    }
  }
  return Object.fromEntries(environment);
}

// oxlint-disable-next-line eslint/func-style, anti-slop/no-unknown-parameters -- Preserve function declaration hoisting and initialization timing. Preserve the existing unknown input contract.
export function gateAEvalWorkflowBodyTimeout(profile: unknown): string | undefined {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
  if (typeof profile !== "object" || profile === null || !Object.isFrozen(profile)) {
    return undefined;
  }
  if (
    Object.keys(profile).toSorted().join(",") !== "image,profile,sourceRoot,version" ||
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- Preserve the existing assertion at this boundary.
    (profile as { version?: unknown }).version !== 1
  ) {
    return undefined;
  }
  // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- Preserve the existing assertion at this boundary.
  const name = (profile as { profile?: unknown }).profile;
  return name === "sandbox" || name === "hosted-artifact" ? "360000" : undefined;
}

// eslint-disable-next-line eslint/func-style, anti-slop/no-unsafe-dictionary-type -- Preserve function declaration hoisting and initialization timing.; Preserve the existing open-ended value contract.
function canonical(proof: Record<string, unknown>) {
  return JSON.stringify(
    Object.fromEntries([
      ["version", proof.version],
      ["nonce", proof.nonce],
      ["context", proof.context],
      ["authorization", proof.authorization],
      ["expiresAt", proof.expiresAt],
      ["capabilities", proof.capabilities],
      ["publicKey", proof.publicKey],
      ["gateAEvalProfile", proof.gateAEvalProfile],
    ]),
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function exactParentArguments(): readonly string[] {
  const pid = process.ppid;
  const expectedExecutable = realpathSync("/bin/sh");
  if (process.platform === "linux") {
    if (realpathSync(`/proc/${pid}/exe`) !== expectedExecutable) {
      throw new Error("The structural test launcher executable was invalid.");
    }
    if (realpathSync(`/proc/${pid}/cwd`) !== realpathSync(repositoryRoot)) {
      throw new Error("The structural test launcher cwd was invalid.");
    }
    const source = readFileSync(`/proc/${pid}/cmdline`);
    return source
      .toString("utf-8")
      .split("\0")
      .filter((entry) => entry.length > 0);
  }
  if (process.platform === "darwin") {
    const python = [
      "import ctypes,json,struct,sys",
      "libc=ctypes.CDLL('/usr/lib/libSystem.B.dylib')",
      "pid=int(sys.argv[1])",
      "mib=(ctypes.c_int*3)(1,49,pid)",
      "size=ctypes.c_size_t(0)",
      "assert libc.sysctl(mib,3,None,ctypes.byref(size),None,0)==0",
      "buf=ctypes.create_string_buffer(size.value)",
      "assert libc.sysctl(mib,3,buf,ctypes.byref(size),None,0)==0",
      "data=buf.raw[:size.value]",
      "argc=struct.unpack_from('i',data)[0]",
      "parts=data[4:].split(b'\\0')[1:]",
      "parts=parts[next(i for i,v in enumerate(parts) if v):]",
      "print(json.dumps([v.decode('utf-8') for v in parts[:argc]]))",
    ].join(";");
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- Preserve the existing assertion at this boundary.
    const observed = JSON.parse(
      execFileSync("/usr/bin/python3", ["-I", "-c", python, String(pid)], {
        encoding: "utf-8",
        env: { LC_ALL: "C", NODE_ENV: "test", PATH: testExecutablePath },
      }),
    ) as unknown;
    if (
      !Array.isArray(observed) ||
      !observed.every((entry): entry is string => typeof entry === "string")
    ) {
      throw new Error("The structural test launcher argv was invalid.");
    }
    const cwd = execFileSync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf-8",
      env: { LC_ALL: "C", NODE_ENV: "test", PATH: testExecutablePath },
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .find((line) => line.startsWith("n"))
      ?.slice(1);
    if (cwd === undefined || realpathSync(cwd) !== realpathSync(repositoryRoot)) {
      throw new Error("The structural test launcher cwd was invalid.");
    }
    return observed;
  }
  throw new Error("Structural test launcher inspection is unsupported.");
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function verifyTrustedLauncher(profile: "eve" | "vitest") {
  const launcherStat = statSync(launcher, { bigint: true });
  const invalidLauncherFile = realpathSync(launcher) !== launcher || !launcherStat.isFile();
  if (
    invalidLauncherFile ||
    launcherStat.uid !== BigInt(process.getuid?.() ?? -1) ||
    launcherStat.nlink !== BigInt(ONE) ||
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    (launcherStat.mode & BigInt(MODE_MASK)) !== BigInt(ZERO)
  ) {
    throw new Error("The structural test launcher source was invalid.");
  }
  const wrapper = profile === "vitest" ? "scripts/run-vitest.mts" : "scripts/run-eve-eval.mts";
  const expected = [
    "/bin/sh",
    launcher,
    process.execPath,
    "--import",
    "tsx",
    wrapper,
    ...process.argv.slice(2),
  ];
  const observed = exactParentArguments();
  if (
    observed.length !== expected.length ||
    observed.some((value, index) => value !== expected[index])
  ) {
    throw new Error("The structural test launcher argv was invalid.");
  }
}

// eslint-disable-next-line eslint/func-style, eslint/require-await -- Preserve function declaration hoisting and initialization timing.
export async function runWithTestCapability(options: {
  profile: "eve" | "vitest";
  command: string;
  args: readonly string[];
  capabilities: readonly string[];
  gateAEvalProfile?: unknown;
}): Promise<number> {
  verifyTrustedLauncher(options.profile);
  if (process.env.NODE_OPTIONS !== undefined) {
    throw new Error("The trusted launcher did not clear ambient NODE_OPTIONS.");
  }
  const expectedEntry = path.resolve(
    repositoryRoot,
    options.profile === "vitest" ? "node_modules/vitest/vitest.mjs" : "node_modules/eve/bin/eve.js",
  );
  if (
    options.command !== process.execPath ||
    options.args[0] !== expectedEntry ||
    (options.profile === "vitest" && options.capabilities.length !== 3)
  ) {
    throw new Error("The structural test wrapper profile was invalid.");
  }
  if (
    (options.profile === "eve" && ![0, 1, 3].includes(options.capabilities.length)) ||
    (options.profile === "eve") !== (options.gateAEvalProfile !== undefined)
  ) {
    throw new Error("The structural test wrapper profile was invalid.");
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeySource = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const privateKeySource = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const evalRuntime = options.profile === "eve" ? createEveEvalRuntimeDirectories() : undefined;
  const child = spawn(options.command, [...options.args], {
    cwd: repositoryRoot,
    detached: options.profile === "eve" && process.platform !== "win32",
    env: {
      ...childEnvironment(),
      APP_BUILDER_EVE_EVAL_FETCH_PRELOAD: options.profile === "eve" ? "1" : undefined,
      // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
      APP_BUILDER_TEST_CAPABILITY_ID: undefined,
      // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
      APP_BUILDER_TEST_MODEL: undefined,
      EVE_DEV_WORKER_APP_ROOT: options.profile === "eve" ? repositoryRoot : undefined,
      HOME: evalRuntime?.home ?? process.env.HOME,
      NODE_ENV: process.env.NODE_ENV,
      NODE_OPTIONS:
        options.profile === "eve"
          ? `--import=${preload} --import=${evalFetchPreload}`
          : `--import=${preload}`,
      // Never recover another eval's unfinished queues. Failed runs retain
      // this task-owned directory for diagnostics; successful runs remove it.
      WORKFLOW_LOCAL_BODY_TIMEOUT_MS: gateAEvalWorkflowBodyTimeout(options.gateAEvalProfile),
      WORKFLOW_LOCAL_DATA_DIR: options.profile === "eve" ? evalRuntime?.workflowData : undefined,
      WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS: gateAEvalWorkflowBodyTimeout(options.gateAEvalProfile),
    },
    stdio: ["inherit", "inherit", "inherit", "pipe"],
  });
  // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Preserve the existing assertion at this boundary. Preserve the existing assertion and its runtime behavior.
  const authorization = child.stdio[3] as Duplex | null | undefined;
  if (authorization === null || authorization === undefined) {
    throw new Error("The structural test authorization pipe was not created.");
  }
  let buffered = "";
  let answered = false;
  authorization.write(`${JSON.stringify({ publicKey: publicKeySource, version: 2 })}\n`);
  // oxlint-disable-next-line typescript/strict-void-return -- Preserve the existing callback return contract.
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  timeout.unref();
  authorization.setEncoding("utf-8");
  authorization.on("data", (chunk: string) => {
    if (answered) {
      return;
    }
    buffered += chunk;
    const newline = buffered.indexOf("\n");
    if (newline === -1 && Buffer.byteLength(buffered) <= maximumFrameBytes) {
      return;
    }
    if (
      newline === -1 ||
      Buffer.byteLength(buffered.slice(0, newline + 1)) > maximumFrameBytes ||
      newline !== buffered.length - 1
    ) {
      child.kill("SIGKILL");
      return;
    }
    try {
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Preserve the existing assertion at this boundary. Preserve the existing assertion and its runtime behavior.
      const request = JSON.parse(buffered) as {
        version?: unknown;
        nonce?: unknown;
        context?: unknown;
      };
      const hasValidEnvelope =
        Object.keys(request).toSorted().join(",") === "context,nonce,version" &&
        request.version === 2;
      if (
        !hasValidEnvelope ||
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
        typeof request.nonce !== "string" ||
        !/^[0-9a-f]{64}$/u.test(request.nonce) ||
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
        typeof request.context !== "string"
      ) {
        throw new Error("Malformed authorization request.");
      }
      const proof = {
        authorization: randomBytes(32).toString("hex"),
        capabilities: options.capabilities,
        context: request.context,
        expiresAt: Date.now() + 5000,
        gateAEvalProfile: options.gateAEvalProfile ?? null,
        nonce: request.nonce,
        publicKey: publicKeySource,
        version: 2,
      };
      const signature = sign(null, Buffer.from(canonical(proof)), privateKey).toString("base64");
      answered = true;
      authorization.write(
        `${JSON.stringify({ ...proof, delegationPrivateKey: privateKeySource, signature })}\n`,
      );
      clearTimeout(timeout);
    } catch {
      child.kill("SIGKILL");
    }
  });
  try {
    const exitCode = await waitForEveEvalChild({ authorization, child });
    if (exitCode === ZERO && evalRuntime !== undefined) {
      rmSync(evalRuntime.root, { recursive: true });
    }
    return exitCode;
  } finally {
    clearTimeout(timeout);
  }
}
