import { randomUUID } from "node:crypto";

import type { SandboxBackend, SandboxBackendHandle, SandboxSeedFile } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";
import {
  DEVELOPMENT_SANDBOX_ENVIRONMENT,
  developmentPinnedToolchainCommand,
} from "../../lib/sandbox/development-toolchain";
import { requirements } from "./self-reproduction-parity";
import type { Observation } from "./self-reproduction-parity";

export interface RuntimeCommandReceipt {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CandidateRuntimeReceipt {
  producer: "evaluator";
  sandboxId?: string;
  status: "available" | "failed" | "infrastructure-unavailable";
  reason: string;
  commands: RuntimeCommandReceipt[];
  probes: {
    id: "root" | "documentation";
    url: string;
    status: number | null;
    passed: boolean;
    detail: string;
    method: "http" | "browser";
    disposition: "observed" | "infrastructure-unavailable";
  }[];
}

/**
 * Converts a runtime prerequisite failure into explicit candidate evidence.
 * Existing, more specific evaluator observations win, and anonymous entry is
 * intentionally outside the current baseline.
 */
function runtimeFailureObservations(input: {
  receipt: CandidateRuntimeReceipt | { status: "not-run" | "failed"; reason: string };
  existingRequirementIds?: ReadonlySet<string>;
  artifact?: string;
  kind: "capture" | "runtime";
}): Observation[] {
  if (input.receipt.status === "available" || input.receipt.status === "not-run") return [];
  const disposition =
    input.receipt.status === "infrastructure-unavailable"
      ? "infrastructure-unavailable"
      : "missing-functionality";
  const artifact = input.artifact ?? "candidate-runtime.json";
  return requirements
    .filter(
      (requirement) =>
        (input.kind === "capture"
          ? requirement.kind === "capture"
          : requirement.kind !== "capture") &&
        requirement.id !== "anonymous-entry" &&
        !input.existingRequirementIds?.has(requirement.id),
    )
    .map((requirement) => ({
      artifacts: [artifact],
      assertions: [],
      disposition,
      method: "none",
      reason:
        disposition === "missing-functionality"
          ? `Candidate runtime prerequisite failed: ${input.receipt.reason}`
          : `Candidate runtime infrastructure was unavailable: ${input.receipt.reason}`,
      requirementId: requirement.id,
    }));
}

/** Returns evaluator-owned fallback evidence accepted by the runtime receipt schema. */
export function candidateRuntimeFailureObservations(
  input: Omit<Parameters<typeof runtimeFailureObservations>[0], "kind">,
) {
  return runtimeFailureObservations({ ...input, kind: "runtime" });
}

/** Returns fallback observations that capture receipt assembly can attach to viewport metadata. */
export function candidateRuntimeCaptureFailureObservations(
  input: Omit<Parameters<typeof runtimeFailureObservations>[0], "kind">,
) {
  return runtimeFailureObservations({ ...input, kind: "capture" });
}

type Backend = SandboxBackend<Record<string, never>, Record<string, never>>;

const excerpt = (value: string) => value.slice(-8000);

async function command(
  handle: SandboxBackendHandle<Record<string, never>>,
  value: string,
  abortSignal: AbortSignal,
): Promise<RuntimeCommandReceipt> {
  const result = await handle.session.run({ abortSignal, command: value });
  return {
    command: value,
    exitCode: result.exitCode,
    stderr: excerpt(result.stderr),
    stdout: excerpt(result.stdout),
  };
}

const readinessScript = (publicBasePath: string) => String.raw`
const basePath = ${JSON.stringify(publicBasePath)};
const target = ["root", "http://127.0.0.1:3000" + basePath];
const deadline = Date.now() + 120000;
while (Date.now() < deadline) {
  try { if ((await fetch(target[1])).status < 500) break; } catch {}
  await new Promise((resolve) => setTimeout(resolve, 500));
}
const probes = [];
try {
  const response = await fetch(target[1], { redirect: "manual" });
  probes.push({ id: target[0], url: target[1], status: response.status, passed: response.status >= 200 && response.status < 400, detail: "Evaluator HTTP readiness response.", method: "http", disposition: "observed" });
} catch (error) {
  probes.push({ id: target[0], url: target[1], status: null, passed: false, detail: error instanceof Error ? error.message : "Request failed.", method: "http", disposition: "observed" });
}
console.log(JSON.stringify(probes));
`;

function candidatePackageName(files: readonly SandboxSeedFile[], appId: string) {
  const manifest = files.find((file) => file.path === "package.json");
  if (manifest)
    try {
      const parsed = JSON.parse(String(manifest.content)) as { name?: unknown };
      if (typeof parsed.name === "string" && parsed.name.length > 0) return parsed.name;
    } catch {
      /* Candidate build reports malformed package metadata. */
    }
  return `@autograph/${appId}`;
}

const registerMicrofrontendScript = (appId: string, packageName: string) => String.raw`
import { readFile, writeFile } from "node:fs/promises";
const path = "/workspace/microfrontends.json";
const config = JSON.parse(await readFile(path, "utf8"));
config.applications["apps-" + ${JSON.stringify(appId)}] = {
  packageName: ${JSON.stringify(packageName)},
  development: { local: 3000 },
  routing: [{ paths: [${JSON.stringify(`/${appId}`)}, ${JSON.stringify(`/${appId}/:path*`)}] }],
};
await writeFile(path, JSON.stringify(config, null, 2) + "\n");
`;

const browserProbeScript = (publicBasePath: string) => String.raw`
import { chromium } from "playwright";
const baseURL = "http://127.0.0.1:3000" + ${JSON.stringify(publicBasePath)};
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
let result;
try {
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  const rootURL = page.url();
  const response = await page.goto(baseURL + "/docs", { waitUntil: "domcontentloaded" });
  const body = (await page.locator("body").innerText()).trim();
  await page.goBack({ waitUntil: "domcontentloaded" });
  const returned = page.url() === rootURL;
  const readable = (response?.status() ?? 0) < 400 && body.length > 40;
  result = { id: "documentation", url: baseURL + "/docs", status: response?.status() ?? null, passed: readable && returned, detail: readable && returned ? "Public documentation rendered and browser back-navigation returned to the original page." : "Documentation readable=" + readable + "; return-navigation=" + returned + ".", method: "browser", disposition: "observed" };
} catch (error) {
  result = { id: "documentation", url: baseURL + "/docs", status: null, passed: false, detail: error instanceof Error ? error.message : "Browser probe failed.", method: "browser", disposition: "observed" };
} finally {
  await context.close();
  await browser.close();
}
console.log(JSON.stringify([result]));
`;

/** Starts an exported candidate in a fresh evaluator-owned Vercel Sandbox.
 * The generated application never receives the backend handle or probe code. */
export async function evaluateCandidateRuntime(input: {
  files: readonly SandboxSeedFile[];
  workspaceArchive: Buffer;
  candidateAppId: string;
  publicBasePath: string;
  credentials?: { token: string; teamId: string; projectId: string };
  appRoot?: string;
  backend?: Backend;
  timeoutMs?: number;
}): Promise<CandidateRuntimeReceipt> {
  const commands: RuntimeCommandReceipt[] = [];
  let handle: SandboxBackendHandle<Record<string, never>> | undefined;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Candidate runtime deadline exceeded.")),
    input.timeoutMs ?? 600_000,
  );
  try {
    const backend = input.backend ?? vercel({ networkPolicy: "allow-all", ...input.credentials });
    handle = await backend.create({
      runtimeContext: { appRoot: input.appRoot ?? "/workspace" },
      sessionKey: `self-reproduction-runtime-${randomUUID()}`,
      tags: { purpose: "self-reproduction-eval" },
      templateKey: null,
    });
    await handle.session.writeBinaryFile({
      content: input.workspaceArchive,
      path: ".self-reproduction-workspace.tar",
    });
    const unpack = await command(
      handle,
      "tar -xf .self-reproduction-workspace.tar && rm .self-reproduction-workspace.tar",
      controller.signal,
    );
    commands.push(unpack);
    if (unpack.exitCode !== 0)
      return {
        commands,
        probes: [],
        producer: "evaluator",
        reason: "Reference workspace reconstruction failed.",
        sandboxId: handle.session.id,
        status: "failed",
      };
    await Promise.all([
      ...input.files.map((file) =>
        handle!.session.writeTextFile({
          content: String(file.content),
          path: `apps/${input.candidateAppId}/${file.path}`,
        }),
      ),
      handle.session.writeTextFile({
        content: registerMicrofrontendScript(
          input.candidateAppId,
          candidatePackageName(input.files, input.candidateAppId),
        ),
        path: ".self-reproduction-register.mjs",
      }),
      handle.session.writeTextFile({
        content: readinessScript(input.publicBasePath),
        path: ".self-reproduction-readiness.mjs",
      }),
      handle.session.writeTextFile({
        content: browserProbeScript(input.publicBasePath),
        path: ".self-reproduction-browser.mjs",
      }),
    ]);
    const runtime = await command(handle, developmentPinnedToolchainCommand(), controller.signal);
    commands.push(runtime);
    if (runtime.exitCode !== 0)
      return {
        commands,
        probes: [],
        producer: "evaluator",
        reason: "Candidate runtime toolchain installation failed.",
        sandboxId: handle.session.id,
        status: "infrastructure-unavailable",
      };
    const runtimeEnvironment = Object.entries(DEVELOPMENT_SANDBOX_ENVIRONMENT)
      .map(([name, value]) => `${name}=${value}`)
      .join(" ");
    const bun = `${runtimeEnvironment} bun`;
    const install = await command(handle, `${bun} install`, controller.signal);
    commands.push(install);
    if (install.exitCode !== 0)
      return {
        commands,
        probes: [],
        producer: "evaluator",
        reason: "Candidate dependency installation failed.",
        sandboxId: handle.session.id,
        status: "failed",
      };
    const microfrontends = await command(
      handle,
      `${bun} .config/mise/scripts/repository/generate-microfrontends.ts`,
      controller.signal,
    );
    commands.push(microfrontends);
    if (microfrontends.exitCode !== 0)
      return {
        commands,
        probes: [],
        producer: "evaluator",
        reason: "Candidate microfrontend configuration failed.",
        sandboxId: handle.session.id,
        status: "failed",
      };
    const registration = await command(
      handle,
      `${runtimeEnvironment} node .self-reproduction-register.mjs`,
      controller.signal,
    );
    commands.push(registration);
    if (registration.exitCode !== 0)
      return {
        commands,
        probes: [],
        producer: "evaluator",
        reason: "Candidate microfrontend registration failed.",
        sandboxId: handle.session.id,
        status: "failed",
      };
    const build = await command(
      handle,
      `VC_MICROFRONTENDS_CONFIG=/workspace/.scratch/microfrontends/microfrontends.json ${bun} run --cwd apps/${input.candidateAppId} build`,
      controller.signal,
    );
    commands.push(build);
    if (build.exitCode !== 0)
      return {
        commands,
        probes: [],
        producer: "evaluator",
        reason: "Candidate build failed.",
        sandboxId: handle.session.id,
        status: "failed",
      };
    await handle.session.spawn({
      abortSignal: controller.signal,
      command: `${bun} run --cwd apps/${input.candidateAppId} start -- --hostname 127.0.0.1 --port 3000`,
    });
    const probe = await command(
      handle,
      `${runtimeEnvironment} node .self-reproduction-readiness.mjs`,
      controller.signal,
    );
    commands.push(probe);
    const probes = probe.exitCode === 0 ? JSON.parse(probe.stdout.trim()) : [];
    const root = Array.isArray(probes)
      ? probes.find((item: { id?: unknown }) => item.id === "root")
      : undefined;
    if (root?.passed === true) {
      const browser = await command(
        handle,
        `${runtimeEnvironment} node .self-reproduction-browser.mjs`,
        controller.signal,
      );
      commands.push(browser);
      if (browser.exitCode === 0) {
        const browserProbes = JSON.parse(browser.stdout.trim());
        if (Array.isArray(browserProbes)) probes.push(...browserProbes);
      } else
        probes.push({
          detail: `Evaluator browser was unavailable: ${browser.stderr || browser.stdout}`,
          disposition: "infrastructure-unavailable",
          id: "documentation",
          method: "browser",
          passed: false,
          status: null,
          url: `http://127.0.0.1:3000${input.publicBasePath}/docs`,
        });
    }
    return {
      commands,
      probes: Array.isArray(probes) ? probes : [],
      producer: "evaluator",
      reason:
        root?.passed === true
          ? "Candidate runtime became ready."
          : "Candidate runtime was not reachable.",
      sandboxId: handle.session.id,
      status: root?.passed === true ? "available" : "failed",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      producer: "evaluator",
      ...(handle === undefined ? {} : { sandboxId: handle.session.id }),
      status:
        handle === undefined && /credential|oidc|sandbox|network|fetch/iu.test(message)
          ? "infrastructure-unavailable"
          : "failed",
      reason: message,
      commands,
      probes: [],
    };
  } finally {
    clearTimeout(timer);
    await handle?.shutdown().catch(() => {
      /* empty */
    });
  }
}
