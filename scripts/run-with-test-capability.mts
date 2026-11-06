import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Duplex } from "node:stream";
import { z } from "zod";

import {
  createEveEvalRuntimeDirectories,
  waitForEveEvalChild,
} from "../lib/testing/eve-eval-lifecycle";

const MODE_MASK = 18;
const ZERO = 0;
const ONE = 1;
const minimalPath = "/usr/bin:/bin";
const colorDisabledEnvironmentName = "NO_COLOR";
const authorizationRequestSchema = z.strictObject({
  context: z.string(),
  nonce: z.string().regex(/^[0-9a-f]{64}$/u),
  version: z.literal(2),
});
const evalProfileSchema = z.strictObject({
  image: z.string().nullable(),
  profile: z.enum(["sandbox", "hosted-artifact"]),
  sourceRoot: z.string().nullable(),
  version: z.literal(1),
});
const authorizationResponseSchema = z.object({
  authorization: z.string(),
  capabilities: z.array(z.string()),
  context: z.string(),
  expiresAt: z.number(),
  gateAEvalProfile: evalProfileSchema.nullable(),
  nonce: z.string(),
  publicKey: z.string(),
  version: z.literal(2),
});
const managedRuntimeTestRootEnvironmentKey = "ARRUSTED_MANAGED_RUNTIME_TEST_ROOT";
type ChildEnvironment = { PATH: string } & Partial<
  Record<(typeof allowedEnvironment)[number], string>
>;

type EvalProfile = z.infer<typeof evalProfileSchema>;
type TestProof = z.infer<typeof authorizationResponseSchema>;

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const repositoryRootStat = statSync(repositoryRoot, { bigint: true });
if (
  !path.isAbsolute(repositoryRoot) ||
  !repositoryRootStat.isDirectory() ||
  realpathSync(repositoryRoot) !== repositoryRoot
) {
  throw new Error("The structural test package root was not owner-bound.");
}
if (
  repositoryRootStat.uid !== BigInt(process.getuid?.() ?? -1) ||
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
  colorDisabledEnvironmentName,
  "FORCE_COLOR",
  "NODE_ENV",
  "VERCEL_OIDC_TOKEN",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
  "APP_BUILDER_EVAL_BROWSER_EXECUTABLE",
  managedRuntimeTestRootEnvironmentKey,
  "BUN_BINARY",
  "APP_BUILDER_DEV_MISE_BIN",
] as const;

function childEnvironment() {
  const environment: ChildEnvironment = { PATH: minimalPath };
  for (const name of allowedEnvironment) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment satisfies NodeJS.ProcessEnv;
}

const parseStringArray = (entries: readonly unknown[]): string[] | undefined => {
  if (!entries.every((entry): entry is string => typeof entry === "string")) {
    return undefined;
  }
  return [...entries];
};

export function gateAEvalWorkflowBodyTimeout(
  profileInput: EvalProfile | undefined,
): string | undefined {
  if (profileInput === undefined) {
    return undefined;
  }
  return "360000";
}

function canonical(proof: TestProof) {
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
    const rawObserved: unknown = JSON.parse(
      execFileSync("/usr/bin/python3", ["-I", "-c", python, String(pid)], {
        encoding: "utf-8",
        env: { LC_ALL: "C", NODE_ENV: "test", PATH: minimalPath },
      }),
    );
    const observed = Array.isArray(rawObserved) ? parseStringArray(rawObserved) : undefined;
    if (observed === undefined) {
      throw new Error("The structural test launcher argv was invalid.");
    }
    const cwd = execFileSync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf-8",
      env: { LC_ALL: "C", NODE_ENV: "test", PATH: minimalPath },
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

function verifyTrustedLauncher(profile: "eve" | "vitest") {
  const launcherStat = statSync(launcher, { bigint: true });
  const launcherIsOwnedAndPrivate =
    launcherStat.isFile() &&
    launcherStat.uid === BigInt(process.getuid?.() ?? -1) &&
    launcherStat.nlink === BigInt(ONE) &&
    (launcherStat.mode & BigInt(MODE_MASK)) === BigInt(ZERO);
  if (realpathSync(launcher) !== launcher || !launcherIsOwnedAndPrivate) {
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
  const argumentCountMatches = observed.length === expected.length;
  const argumentsMatch =
    argumentCountMatches && observed.every((value, index) => value === expected[index]);
  if (!argumentsMatch) {
    throw new Error("The structural test launcher argv was invalid.");
  }
}

export async function runWithTestCapability(options: {
  profile: "eve" | "vitest";
  command: string;
  args: readonly string[];
  capabilities: readonly string[];
  gateAEvalProfile?: EvalProfile;
}): Promise<number> {
  verifyTrustedLauncher(options.profile);
  if (process.env.NODE_OPTIONS !== undefined) {
    throw new Error("The trusted launcher did not clear ambient NODE_OPTIONS.");
  }
  const expectedEntry = path.resolve(
    repositoryRoot,
    options.profile === "vitest" ? "node_modules/vitest/vitest.mjs" : "node_modules/eve/bin/eve.js",
  );
  const capabilityCount = options.capabilities.length;
  const vitestCapabilitiesValid = capabilityCount === 3;
  const eveCapabilitiesValid = [ZERO, ONE, 3].includes(capabilityCount);
  const invalidCapabilities =
    options.profile === "vitest" ? !vitestCapabilitiesValid : !eveCapabilitiesValid;
  const evalProfileMatches =
    (options.profile === "eve") === (options.gateAEvalProfile !== undefined);
  if (
    options.command !== process.execPath ||
    options.args[0] !== expectedEntry ||
    invalidCapabilities ||
    !evalProfileMatches
  ) {
    throw new Error("The structural test wrapper profile was invalid.");
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeySource = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const privateKeySource = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const evalRuntime = options.profile === "eve" ? createEveEvalRuntimeDirectories() : undefined;
  const environment = childEnvironment();
  const assignEnvironment = (name: string, value: string | undefined) => {
    if (value === undefined) {
      Reflect.deleteProperty(environment, name);
      return;
    }
    environment[name] = value;
  };
  assignEnvironment(
    "APP_BUILDER_EVE_EVAL_FETCH_PRELOAD",
    options.profile === "eve" ? "1" : undefined,
  );
  delete environment.APP_BUILDER_TEST_CAPABILITY_ID;
  delete environment.APP_BUILDER_TEST_MODEL;
  assignEnvironment(
    "EVE_DEV_WORKER_APP_ROOT",
    options.profile === "eve" ? repositoryRoot : undefined,
  );
  assignEnvironment("HOME", evalRuntime?.home ?? process.env.HOME);
  environment.NODE_OPTIONS =
    options.profile === "eve"
      ? `--import=${preload} --import=${evalFetchPreload}`
      : `--import=${preload}`;
  assignEnvironment(
    "WORKFLOW_LOCAL_BODY_TIMEOUT_MS",
    gateAEvalWorkflowBodyTimeout(options.gateAEvalProfile),
  );
  assignEnvironment(
    "WORKFLOW_LOCAL_DATA_DIR",
    options.profile === "eve" ? evalRuntime?.workflowData : undefined,
  );
  assignEnvironment(
    "WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS",
    gateAEvalWorkflowBodyTimeout(options.gateAEvalProfile),
  );
  const child: ChildProcessByStdio<
    NodeJS.WritableStream,
    NodeJS.ReadableStream,
    NodeJS.ReadableStream
  > = spawn(options.command, [...options.args], {
    cwd: repositoryRoot,
    detached: options.profile === "eve" && process.platform !== "win32",
    env: environment,
    stdio: ["pipe", "inherit", "inherit", "pipe"],
  });
  const { 3: authorizationCandidate } = child.stdio;
  if (!(authorizationCandidate instanceof Duplex)) {
    throw new Error("The structural test authorization pipe was not created.");
  }
  // SAFETY: stdio index 3 was configured as a pipe and the runtime check confirmed a Duplex.
  const authorization = authorizationCandidate;
  let buffered = "";
  let answered = false;
  authorization.write(`${JSON.stringify({ publicKey: publicKeySource, version: 2 })}\n`);
  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
  }, 10_000);
  timeout.unref();
  authorization.setEncoding("utf-8");
  authorization.on("data", (chunk: Buffer | string) => {
    if (answered) {
      return;
    }
    buffered += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : chunk;
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
      const requestPayload: unknown = JSON.parse(buffered);
      const request = authorizationRequestSchema.parse(requestPayload);
      const proof = {
        authorization: randomBytes(32).toString("hex"),
        capabilities: options.capabilities,
        context: request.context,
        expiresAt: Date.now() + 5000,
        gateAEvalProfile: options.gateAEvalProfile ?? null,
        nonce: request.nonce,
        publicKey: publicKeySource,
        version: 2,
      } satisfies TestProof;
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
    if (exitCode === ZERO && evalRuntime !== null) {
      rmSync(evalRuntime.root, { recursive: true });
    }
    return exitCode;
  } finally {
    clearTimeout(timeout);
  }
}
