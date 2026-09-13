/* oxlint-disable eslint/no-await-in-loop -- preserve deterministic archive collection and partial error handling */
import {
  DEVELOPMENT_SANDBOX_ENVIRONMENT,
  developmentPinnedToolchainCommand,
} from "../sandbox/development-toolchain";

/** Serialized into a trusted worker; dependencies install before the normal eval task starts. */
export const runHostedEvalWorker = async () => {
  const { spawn } = await import("node:child_process");
  const { mkdir, readFile, writeFile, rename, readdir, lstat } = await import("node:fs/promises");
  const { default: path } = await import("node:path");
  const config = JSON.parse(await readFile(process.argv[2], "utf-8"));
  const output = "/tmp/self-reproduction-output";
  const control = "/tmp/self-reproduction-worker";
  const repository = "/vercel/sandbox";
  const template = "/tmp/self-reproduction-arrusted";
  await mkdir(control, { recursive: true });
  const templateToken = process.env.APP_BUILDER_TEMPLATE_READ_TOKEN;
  delete process.env.APP_BUILDER_TEMPLATE_READ_TOKEN;
  const credentials = [
    process.env.VERCEL_OIDC_TOKEN,
    templateToken,
    templateToken ? Buffer.from(`x-access-token:${templateToken}`).toString("base64") : undefined,
  ].filter(Boolean) as string[];
  let log = "";
  let phase = "toolchain";
  let exitCode = 1;
  const sanitize = (text: string) => {
    let sanitized = text;
    for (const secret of credentials) sanitized = sanitized.replaceAll(secret, "[REDACTED]");
    return sanitized.replaceAll(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
      "[REDACTED JWT]",
    );
  };
  const run = (cmd: string, args: string[], env = process.env) =>
    // oxlint-disable-next-line promise/avoid-new -- bridge child process events into a single completion
    new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, { cwd: repository, env, stdio: ["ignore", "pipe", "pipe"] });
      let diagnostic = "";
      child.stdout.on("data", (chunk) => {
        diagnostic += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        diagnostic += chunk.toString();
      });
      child.on("error", () => reject(new Error(`${phase}: command could not start`)));
      child.on("close", (code) => {
        log += `${phase}: exit=${code}\n${sanitize(diagnostic).slice(-16_000)}\n`;
        if (code === 0) resolve();
        else reject(new Error(`${phase}: command exit ${code}`));
      });
    });
  try {
    await run("bash", ["-c", config.toolchain]);
    const environment = {
      ...process.env,
      ...config.environment,
      SELF_REPRODUCTION_WORKLOAD_IDENTITY_FILE: "/tmp/self-reproduction-identity.json",
    };
    delete environment.APP_BUILDER_TEMPLATE_READ_TOKEN;
    if (!templateToken) throw new Error("template source credential unavailable");
    phase = "template-clone";
    await run(
      "git",
      [
        "clone",
        "--depth",
        "1",
        "--branch",
        "main",
        "https://github.com/withAutograph/arrusted-development.git",
        template,
      ],
      {
        ...environment,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${templateToken}`).toString("base64")}`,
        GIT_TERMINAL_PROMPT: "0",
      },
    );
    phase = "repository-tools";
    await run("/workspace/.app-builder/toolchain/bin/mise", ["trust"], environment);
    await run(
      "/workspace/.app-builder/toolchain/bin/mise",
      ["install", "node", "pnpm"],
      environment,
    );
    phase = "dependencies";
    await run(
      "/workspace/.app-builder/toolchain/bin/mise",
      ["run", "dependencies:install"],
      environment,
    );
    phase = "postgres-tools";
    await run("sudo", ["dnf", "install", "-y", "postgresql16-server"], environment);
    phase = "evaluation";
    await run(
      "/workspace/.app-builder/toolchain/bin/mise",
      [
        "run",
        "eval:self-reproduction",
        "--",
        "--hosted-oidc",
        "--arrusted-root",
        template,
        "--output-dir",
        output,
        "--postgres-backend",
        "process",
      ],
      environment,
    );
    exitCode = 0;
  } catch (error) {
    log += `${sanitize(error instanceof Error ? error.message : String(error))}\n`;
  }
  const artifacts = [{ contentType: "text/plain", id: "worker.log" }];
  await writeFile(path.join(control, "worker.log"), sanitize(log), { mode: 0o600 });
  const permittedDirectories = new Set([
    "candidate",
    "candidate-browser",
    "candidate-interactions",
    "candidate-navigation",
    "captures",
    "parity",
  ]);
  const retained: string[] = [];
  const walk = async (directory: string, relative = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".env") || ["node_modules", ".git", ".next"].includes(entry.name))
        continue;
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      const info = await lstat(path.join(directory, entry.name));
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory() && (relative || permittedDirectories.has(entry.name)))
        await walk(path.join(directory, entry.name), relativePath);
      else if (info.isFile() && (relative || /\.(?:json|jsonl|md|html)$/u.test(entry.name)))
        retained.push(relativePath);
    }
  };
  try {
    await walk(output);
    if (!retained.length) throw new Error("No eval reports were retained.");
    if (retained.length) {
      phase = "artifact-archive";
      await run("tar", [
        "-czf",
        path.join(control, "evidence.tar.gz"),
        "-C",
        output,
        "--",
        ...retained,
      ]);
      artifacts.push({ contentType: "application/gzip", id: "evidence.tar.gz" });
    }
  } catch {
    exitCode = 1;
    log += "Artifact collection failed; worker log retained.\n";
    await writeFile(path.join(control, "worker.log"), sanitize(log), { mode: 0o600 });
  }
  await writeFile(
    path.join(control, "result.tmp"),
    JSON.stringify({ artifacts, status: exitCode === 0 ? "completed" : "failed" }),
    { mode: 0o600 },
  );
  await rename(path.join(control, "result.tmp"), path.join(control, "result.json"));
};

export const hostedEvalBootstrapFiles = () => [
  {
    content: Buffer.from(
      `const __name = (value) => value;\nawait (${runHostedEvalWorker.toString()})();\n`,
    ),
    path: "/tmp/self-reproduction-worker-bootstrap.mjs",
  },
  {
    content: Buffer.from(
      JSON.stringify({
        environment: DEVELOPMENT_SANDBOX_ENVIRONMENT,
        toolchain: developmentPinnedToolchainCommand(),
      }),
    ),
    path: "/tmp/self-reproduction-worker-config.json",
  },
];
