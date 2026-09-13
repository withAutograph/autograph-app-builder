import { randomUUID } from "node:crypto";

import type { SandboxBackend, SandboxBackendHandle, SandboxSeedFile } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";
import {
  DEVELOPMENT_SANDBOX_ENVIRONMENT,
  developmentPinnedToolchainCommand,
} from "../../lib/sandbox/development-toolchain";

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

type Backend = SandboxBackend<Record<string, never>, Record<string, never>>;

const excerpt = (value: string) => value.slice(-8000);

async function command(
  handle: SandboxBackendHandle<Record<string, never>>,
  value: string,
  abortSignal: AbortSignal,
): Promise<RuntimeCommandReceipt> {
  const result = await handle.session.run({ command: value, abortSignal });
  return {
    command: value,
    exitCode: result.exitCode,
    stdout: excerpt(result.stdout),
    stderr: excerpt(result.stderr),
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
      templateKey: null,
      sessionKey: `self-reproduction-runtime-${randomUUID()}`,
      tags: { purpose: "self-reproduction-eval" },
      runtimeContext: { appRoot: input.appRoot ?? "/workspace" },
    });
    await handle.session.writeBinaryFile({
      path: ".self-reproduction-workspace.tar",
      content: input.workspaceArchive,
    });
    const unpack = await command(
      handle,
      "tar -xf .self-reproduction-workspace.tar && rm .self-reproduction-workspace.tar",
      controller.signal,
    );
    commands.push(unpack);
    if (unpack.exitCode !== 0)
      return {
        producer: "evaluator",
        sandboxId: handle.session.id,
        status: "failed",
        reason: "Reference workspace reconstruction failed.",
        commands,
        probes: [],
      };
    await Promise.all([
      ...input.files.map((file) =>
        handle!.session.writeTextFile({
          path: `apps/${input.candidateAppId}/${file.path}`,
          content: String(file.content),
        }),
      ),
      handle.session.writeTextFile({
        path: ".self-reproduction-register.mjs",
        content: registerMicrofrontendScript(
          input.candidateAppId,
          candidatePackageName(input.files, input.candidateAppId),
        ),
      }),
      handle.session.writeTextFile({
        path: ".self-reproduction-readiness.mjs",
        content: readinessScript(input.publicBasePath),
      }),
      handle.session.writeTextFile({
        path: ".self-reproduction-browser.mjs",
        content: browserProbeScript(input.publicBasePath),
      }),
    ]);
    const runtime = await command(handle, developmentPinnedToolchainCommand(), controller.signal);
    commands.push(runtime);
    if (runtime.exitCode !== 0)
      return {
        producer: "evaluator",
        sandboxId: handle.session.id,
        status: "infrastructure-unavailable",
        reason: "Candidate runtime toolchain installation failed.",
        commands,
        probes: [],
      };
    const runtimeEnvironment = Object.entries(DEVELOPMENT_SANDBOX_ENVIRONMENT)
      .map(([name, value]) => `${name}=${value}`)
      .join(" ");
    const bun = `${runtimeEnvironment} bun`;
    const install = await command(handle, `${bun} install`, controller.signal);
    commands.push(install);
    if (install.exitCode !== 0)
      return {
        producer: "evaluator",
        sandboxId: handle.session.id,
        status: "failed",
        reason: "Candidate dependency installation failed.",
        commands,
        probes: [],
      };
    const microfrontends = await command(
      handle,
      `${bun} .config/mise/scripts/repository/generate-microfrontends.ts`,
      controller.signal,
    );
    commands.push(microfrontends);
    if (microfrontends.exitCode !== 0)
      return {
        producer: "evaluator",
        sandboxId: handle.session.id,
        status: "failed",
        reason: "Candidate microfrontend configuration failed.",
        commands,
        probes: [],
      };
    const registration = await command(
      handle,
      `${runtimeEnvironment} node .self-reproduction-register.mjs`,
      controller.signal,
    );
    commands.push(registration);
    if (registration.exitCode !== 0)
      return {
        producer: "evaluator",
        sandboxId: handle.session.id,
        status: "failed",
        reason: "Candidate microfrontend registration failed.",
        commands,
        probes: [],
      };
    const build = await command(
      handle,
      `VC_MICROFRONTENDS_CONFIG=/workspace/.scratch/microfrontends/microfrontends.json ${bun} run --cwd apps/${input.candidateAppId} build`,
      controller.signal,
    );
    commands.push(build);
    if (build.exitCode !== 0)
      return {
        producer: "evaluator",
        sandboxId: handle.session.id,
        status: "failed",
        reason: "Candidate build failed.",
        commands,
        probes: [],
      };
    await handle.session.spawn({
      command: `${bun} run --cwd apps/${input.candidateAppId} start -- --hostname 127.0.0.1 --port 3000`,
      abortSignal: controller.signal,
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
          id: "documentation",
          url: `http://127.0.0.1:3000${input.publicBasePath}/docs`,
          status: null,
          passed: false,
          detail: `Evaluator browser was unavailable: ${browser.stderr || browser.stdout}`,
          method: "browser",
          disposition: "infrastructure-unavailable",
        });
    }
    return {
      producer: "evaluator",
      sandboxId: handle.session.id,
      status: root?.passed === true ? "available" : "failed",
      reason:
        root?.passed === true
          ? "Candidate runtime became ready."
          : "Candidate runtime was not reachable.",
      commands,
      probes: Array.isArray(probes) ? probes : [],
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
    await handle?.shutdown().catch(() => undefined);
  }
}
