/** Evaluator-only tooling; install in scratch space, never the generated app. */
export const candidateCapabilityTooling = {
  directory: ".scratch/self-reproduction-capabilities",
  dependencies: { "@vercel/sandbox": "2.8.0" },
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
export async function exerciseCandidateCapabilities(ports: ProbePorts) {
  const receipt = {
    producer: "evaluator",
    applicationFunctionalCredit: false,
    model: { status: "blocked", detail: "Model probe not completed." } as ProbeOutcome,
    childSandbox: {
      status: "blocked",
      detail: "Child Sandbox probe not completed.",
    } as ProbeOutcome,
    childCleanup: { status: "blocked", detail: "No child Sandbox acquired." } as ProbeOutcome,
  };
  try {
    const text = await ports.model();
    receipt.model = {
      status: text.trim() ? "passed" : "failed",
      detail: text.trim() ? "Live model returned nonempty text." : "Model returned empty text.",
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
      status: passed ? "passed" : "failed",
      detail: passed
        ? "Child Sandbox executed the evaluator sentinel."
        : "Child command did not return the expected sentinel.",
    };
  } catch {
    receipt.childSandbox.detail =
      "Child Sandbox SDK, credentials, or provider operation unavailable.";
  } finally {
    if (child) {
      try {
        await child.stop();
        receipt.childCleanup = { status: "passed", detail: "Child Sandbox stopped." };
      } catch {
        receipt.childCleanup = {
          status: "failed",
          detail: "Child stop failed; bounded provider timeout remains active.",
        };
      }
    }
  }
  return receipt;
}

/** Compatible with runSandboxRuntimeComparison; payload accepts only the selected model ID. */
export function sandboxCandidateCapabilityProbe() {
  return {
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
      maxOutputTokens: 16,
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
  };
}
