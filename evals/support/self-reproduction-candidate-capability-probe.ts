import { DEVELOPMENT_SANDBOX_ENVIRONMENT } from "../../lib/sandbox/development-toolchain";
import { runSandboxRuntimeComparison } from "./self-reproduction-runtime-comparison";

/** Evaluator-only tooling; install in scratch space, never the generated app. */
export const candidateCapabilityTooling = {
  dependencies: { "@vercel/sandbox": "2.8.0" },
  directory: ".scratch/self-reproduction-capabilities",
} as const;

interface ProbeOutcome {
  status: "passed" | "failed" | "blocked";
  detail: string;
}
interface ProbePorts {
  model: () => Promise<string>;
  createChild: () => Promise<{
    run: () => Promise<{ exitCode: number; stdout: string }>;
    stop: () => Promise<void>;
  }>;
}

/** These assertions prove infrastructure access only, never generated product behavior. */
export const exerciseCandidateCapabilities = async (ports: ProbePorts) => {
  const receipt = {
    applicationFunctionalCredit: false,
    childCleanup: { detail: "No child Sandbox acquired.", status: "blocked" } as ProbeOutcome,
    childSandbox: {
      detail: "Child Sandbox probe not completed.",
      status: "blocked",
    } as ProbeOutcome,
    model: { detail: "Model probe not completed.", status: "blocked" } as ProbeOutcome,
    producer: "evaluator",
  };
  try {
    const text = await ports.model();
    receipt.model = {
      detail: text.trim() ? "Live model returned nonempty text." : "Model returned empty text.",
      status: text.trim() ? "passed" : "failed",
    };
  } catch {
    receipt.model.detail =
      "Model SDK, credentials, or provider request unavailable; no product credit.";
  }
  let child: Awaited<ReturnType<ProbePorts["createChild"]>> | undefined;
  try {
    child = await ports.createChild();
    const command = await child.run();
    const passed = command.exitCode === 0 && command.stdout.trim() === "candidate-capability-ok";
    receipt.childSandbox = {
      detail: passed
        ? "Child Sandbox executed the evaluator sentinel."
        : "Child command did not return the expected sentinel.",
      status: passed ? "passed" : "failed",
    };
  } catch {
    receipt.childSandbox.detail =
      "Child Sandbox SDK, credentials, or provider operation unavailable.";
  } finally {
    if (child) {
      try {
        await child.stop();
        receipt.childCleanup = { detail: "Child Sandbox stopped.", status: "passed" };
      } catch {
        receipt.childCleanup = {
          detail: "Child stop failed; bounded provider timeout remains active.",
          status: "failed",
        };
      }
    }
  }
  return receipt;
};

/** Compatible with runSandboxRuntimeComparison; payload accepts only the selected model ID. */
export const sandboxCandidateCapabilityProbe = () => ({
  script: `
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const __name = (value) => value;
const exercise = ${exerciseCandidateCapabilities.toString()};
const input = JSON.parse(await readFile(process.argv[2], "utf8"));
const rootRequire = createRequire(resolve("package.json"));
const scratchRequire = createRequire(resolve(${JSON.stringify(candidateCapabilityTooling.directory)}, "package.json"));
const receipt = await exercise({
  model: async () => {
    const { generateText } = await import(pathToFileURL(rootRequire.resolve("ai")).href);
    const result = await generateText({
      model: input.model,
      prompt: "Reply with the single word ready.",
      maxOutputTokens: 256,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(60000),
    });
    return result.text;
  },
  createChild: async () => {
    const { Sandbox } = await import(pathToFileURL(scratchRequire.resolve("@vercel/sandbox")).href);
    const child = await Sandbox.create({
      token: process.env.VERCEL_OIDC_TOKEN,
      teamId: process.env.VERCEL_TEAM_ID,
      projectId: process.env.VERCEL_PROJECT_ID,
      networkPolicy: "allow-all",
      timeout: 60000,
      runtime: "node24",
    });
    return {
      run: async () => {
        const result = await child.runCommand({cmd: "printf", args: ["candidate-capability-ok"]});
        return { exitCode: result.exitCode, stdout: await result.stdout() };
      },
      stop: async () => { await child.stop(); },
    };
  },
});
await writeFile(process.argv[3], JSON.stringify(receipt));
`,
});

/** Opt-in infrastructure diagnostic; setup never writes generated application files. */
export const runCandidateCapabilityProbe = async (input: {
  session: Parameters<typeof runSandboxRuntimeComparison>[0]["session"];
  abortSignal: AbortSignal;
  model: string;
}) => {
  const setup = { exitCode: null as number | null, stderr: "", stdout: "" };
  try {
    await input.session.writeTextFile({
      content: JSON.stringify({
        dependencies: candidateCapabilityTooling.dependencies,
        private: true,
      }),
      path: `${candidateCapabilityTooling.directory}/package.json`,
    });
    const environment = Object.entries(DEVELOPMENT_SANDBOX_ENVIRONMENT)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(" ");
    const result = await input.session.run({
      abortSignal: input.abortSignal,
      command: `${environment} bun install --cwd ${candidateCapabilityTooling.directory}`,
    });
    Object.assign(setup, {
      exitCode: result.exitCode,
      stderr: result.stderr,
      stdout: result.stdout,
    });
    if (result.exitCode !== 0)
      return {
        applicationFunctionalCredit: false,
        comparison: null,
        reason: "Evaluator-only capability tooling installation failed.",
        setup,
        status: "blocked" as const,
      };
    const comparison = await runSandboxRuntimeComparison({
      abortSignal: input.abortSignal,
      ...sandboxCandidateCapabilityProbe(),
      payload: { model: input.model },
      session: input.session,
    });
    return { applicationFunctionalCredit: false, comparison, setup, status: comparison.status };
  } catch {
    return {
      applicationFunctionalCredit: false,
      comparison: null,
      reason: "Evaluator-only capability tooling or runtime unavailable.",
      setup,
      status: "blocked" as const,
    };
  }
};
