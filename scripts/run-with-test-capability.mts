import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";

const repositoryRoot = resolve(import.meta.dirname, "..");
const preload = pathToFileURL(
  resolve(repositoryRoot, "scripts/test-capability-preload.mjs"),
).href;
const maximumFrameBytes = 4096;
const launcher = resolve(
  repositoryRoot,
  ".config/mise/scripts/trusted-node-launcher",
);
const launcherDigest =
  "4e5b10e3359ced24e7ab98790c438bfc1611c5312cf7165a1b8c12d616710c28";
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
  "APP_BUILDER_LOCAL_PUBLICATION",
  "APP_BUILDER_BRANCH_WORKTREE_PUBLICATION",
  "APP_BUILDER_BRANCH_WORKTREE_ROOT",
  "APP_BUILDER_FRESH_BOOTSTRAP_ENABLED",
  "APP_BUILDER_FRESH_BOOTSTRAP_STATE_ROOT",
  "APP_BUILDER_FRESH_BOOTSTRAP_ALLOWED_ROOT",
  "APP_BUILDER_FRESH_BOOTSTRAP_EVAL_FAULT",
  "APP_BUILDER_REAL_SANDBOX",
  "APP_BUILDER_SANDBOX_IMAGE",
  "APP_BUILDER_LOCAL_ADAPTER",
  "EVE_AGENT_HOST",
  "REPOSITORY_LOCAL_ROOTS",
  "REPOSITORY_WORKSPACE_ROOT",
] as const;

function childEnvironment(): NodeJS.ProcessEnv {
  const environment: Record<string, string | undefined> = {
    PATH: "/usr/bin:/bin",
  };
  for (const name of allowedEnvironment) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment as NodeJS.ProcessEnv;
}

function canonical(proof: Record<string, unknown>) {
  return JSON.stringify({
    version: proof.version,
    nonce: proof.nonce,
    context: proof.context,
    authorization: proof.authorization,
    expiresAt: proof.expiresAt,
    capabilities: proof.capabilities,
    publicKey: proof.publicKey,
  });
}

function exactParentArguments(): readonly string[] {
  const pid = process.ppid;
  const expectedExecutable = realpathSync("/bin/sh");
  if (process.platform === "linux") {
    if (realpathSync(`/proc/${pid}/exe`) !== expectedExecutable)
      throw new Error("The structural test launcher executable was invalid.");
    if (realpathSync(`/proc/${pid}/cwd`) !== realpathSync(repositoryRoot))
      throw new Error("The structural test launcher cwd was invalid.");
    const source = readFileSync(`/proc/${pid}/cmdline`);
    return source
      .toString("utf8")
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
    const observed = JSON.parse(
      execFileSync("/usr/bin/python3", ["-I", "-c", python, String(pid)], {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C", NODE_ENV: "test" },
      }),
    ) as unknown;
    if (
      !Array.isArray(observed) ||
      observed.some((entry) => typeof entry !== "string")
    )
      throw new Error("The structural test launcher argv was invalid.");
    const cwd = execFileSync(
      "/usr/sbin/lsof",
      ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
      {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C", NODE_ENV: "test" },
        stdio: ["ignore", "pipe", "ignore"],
      },
    )
      .split("\n")
      .find((line) => line.startsWith("n"))
      ?.slice(1);
    if (cwd === undefined || realpathSync(cwd) !== realpathSync(repositoryRoot))
      throw new Error("The structural test launcher cwd was invalid.");
    return observed as string[];
  }
  throw new Error("Structural test launcher inspection is unsupported.");
}

function verifyTrustedLauncher(profile: "eve" | "vitest") {
  const launcherStat = statSync(launcher, { bigint: true });
  if (
    realpathSync(launcher) !== launcher ||
    !launcherStat.isFile() ||
    launcherStat.uid !== BigInt(process.getuid?.() ?? -1) ||
    launcherStat.nlink !== BigInt(1) ||
    (launcherStat.mode & BigInt(0o022)) !== BigInt(0) ||
    createHash("sha256").update(readFileSync(launcher)).digest("hex") !==
      launcherDigest
  )
    throw new Error("The structural test launcher source was invalid.");
  const wrapper =
    profile === "vitest"
      ? "scripts/run-vitest.mts"
      : "scripts/run-eve-eval.mts";
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
  )
    throw new Error("The structural test launcher argv was invalid.");
}

export async function runWithTestCapability(options: {
  profile: "eve" | "vitest";
  command: string;
  args: readonly string[];
  capabilities: readonly string[];
}): Promise<number> {
  verifyTrustedLauncher(options.profile);
  if (process.env.NODE_OPTIONS !== undefined)
    throw new Error("The trusted launcher did not clear ambient NODE_OPTIONS.");
  const expectedEntry = resolve(
    repositoryRoot,
    options.profile === "vitest"
      ? "node_modules/vitest/vitest.mjs"
      : "node_modules/eve/bin/eve.js",
  );
  if (
    options.command !== process.execPath ||
    options.args[0] !== expectedEntry ||
    (options.profile === "vitest" && options.capabilities.length !== 3) ||
    (options.profile === "eve" && ![1, 3].includes(options.capabilities.length))
  )
    throw new Error("The structural test wrapper profile was invalid.");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeySource = publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");
  const privateKeySource = privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64");
  const child = spawn(options.command, [...options.args], {
    cwd: repositoryRoot,
    stdio: ["inherit", "inherit", "inherit", "pipe"],
    env: {
      ...childEnvironment(),
      NODE_OPTIONS: `--import=${preload}`,
      APP_BUILDER_TEST_MODEL: undefined,
      APP_BUILDER_TEST_CAPABILITY_ID: undefined,
    },
  });
  const authorization = child.stdio[3] as Duplex | null | undefined;
  if (authorization == null)
    throw new Error("The structural test authorization pipe was not created.");
  let buffered = "";
  let answered = false;
  authorization.write(
    `${JSON.stringify({ version: 2, publicKey: publicKeySource })}\n`,
  );
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  timeout.unref();
  authorization.setEncoding("utf8");
  authorization.on("data", (chunk: string) => {
    if (answered) return;
    buffered += chunk;
    const newline = buffered.indexOf("\n");
    if (newline < 0 && Buffer.byteLength(buffered) <= maximumFrameBytes) return;
    if (
      newline < 0 ||
      Buffer.byteLength(buffered.slice(0, newline + 1)) > maximumFrameBytes ||
      newline !== buffered.length - 1
    ) {
      child.kill("SIGKILL");
      return;
    }
    try {
      const request = JSON.parse(buffered) as {
        version?: unknown;
        nonce?: unknown;
        context?: unknown;
      };
      if (
        Object.keys(request).sort().join(",") !== "context,nonce,version" ||
        request.version !== 2 ||
        typeof request.nonce !== "string" ||
        !/^[0-9a-f]{64}$/u.test(request.nonce) ||
        typeof request.context !== "string"
      )
        throw new Error("Malformed authorization request.");
      const proof: Record<string, unknown> = {
        version: 2,
        nonce: request.nonce,
        context: request.context,
        authorization: randomBytes(32).toString("hex"),
        expiresAt: Date.now() + 5_000,
        capabilities: options.capabilities,
        publicKey: publicKeySource,
      };
      const signature = sign(
        null,
        Buffer.from(canonical(proof)),
        privateKey,
      ).toString("base64");
      answered = true;
      authorization.write(
        `${JSON.stringify({ ...proof, signature, delegationPrivateKey: privateKeySource })}\n`,
      );
      clearTimeout(timeout);
    } catch {
      child.kill("SIGKILL");
    }
  });
  return new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      authorization.destroy();
      resolveExit(code ?? (signal === null ? 1 : 128));
    });
  });
}
