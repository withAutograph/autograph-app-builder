import { randomUUID } from "node:crypto";

import type { SandboxSession } from "eve/sandbox";
import type { SandboxProviderTargetFile } from "eve/sandbox/provider";
import { Sandbox } from "@vercel/sandbox";
import { createVercelSdkSession } from "../../lib/sandbox/vercel-sdk-session";
import {
  DEVELOPMENT_SANDBOX_ENVIRONMENT,
  developmentPinnedToolchainCommand,
} from "../../lib/sandbox/development-toolchain";
import { requirements } from "./self-reproduction-parity";

export interface RuntimeCommandReceipt {
  command: string;
  exitCode: number | null;
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
    readable?: boolean;
    returned?: boolean;
  }[];
}

const infrastructureUnavailable = "infrastructure-unavailable" as const;
const candidateRuntimeArtifact = "candidate-runtime.json";
const anonymousEntryRequirement = "anonymous-entry";
const emptyRequirementIds: ReadonlySet<string> = new Set();
const runtimeFailureReason = "Candidate runtime prerequisite failed: ";
interface RuntimeFailureObservation {
  artifacts: string[];
  assertions: never[];
  disposition: "infrastructure-unavailable" | "missing-functionality";
  method: "none";
  reason: string;
  requirementId: string;
}

/**
 * Converts a runtime prerequisite failure into explicit candidate evidence.
 * Existing, more specific evaluator observations win, and anonymous entry is
 * intentionally outside the current baseline.
 */
const runtimeFailureObservations = (input: {
  receipt: CandidateRuntimeReceipt | { status: "not-run" | "failed"; reason: string };
  existingRequirementIds?: ReadonlySet<string>;
  artifact?: string;
  kind: "capture" | "runtime";
}) => {
  if (input.receipt.status === "available" || input.receipt.status === "not-run") {
    return [];
  }
  const disposition =
    input.receipt.status === infrastructureUnavailable
      ? infrastructureUnavailable
      : "missing-functionality";
  const artifact = input.artifact ?? candidateRuntimeArtifact;
  const observations: RuntimeFailureObservation[] = [];
  for (const requirement of requirements) {
    const matchesKind =
      input.kind === "capture" ? requirement.kind === "capture" : requirement.kind !== "capture";
    if (
      !matchesKind ||
      requirement.id === anonymousEntryRequirement ||
      (input.existingRequirementIds ?? emptyRequirementIds).has(requirement.id)
    ) {
      continue;
    }
    observations.push({
      artifacts: [artifact],
      assertions: [],
      disposition,
      method: "none",
      reason:
        disposition === "missing-functionality"
          ? `${runtimeFailureReason}${input.receipt.reason}`
          : `Candidate runtime infrastructure was unavailable: ${input.receipt.reason}`,
      requirementId: requirement.id,
    });
  }
  return observations;
};

/** Returns evaluator-owned fallback evidence accepted by the runtime receipt schema. */
export const candidateRuntimeFailureObservations = (
  input: Omit<Parameters<typeof runtimeFailureObservations>[0], "kind">,
) => runtimeFailureObservations({ ...input, kind: "runtime" });

/** Returns fallback observations that capture receipt assembly can attach to viewport metadata. */
export const candidateRuntimeCaptureFailureObservations = (
  input: Omit<Parameters<typeof runtimeFailureObservations>[0], "kind">,
) => runtimeFailureObservations({ ...input, kind: "capture" });

export interface CandidateRuntimeSandbox {
  readonly id: string;
  readonly session: SandboxSession;
  readonly shutdown: () => Promise<void>;
}

interface CandidateRuntimeProvider {
  readonly open: () => Promise<CandidateRuntimeSandbox>;
}

const excerpt = (value: string) => value.slice(-8000);

const command = async (
  handle: CandidateRuntimeSandbox,
  value: string,
  abortSignal: AbortSignal,
): Promise<RuntimeCommandReceipt> => {
  const result = await handle.session.run({ abortSignal, command: value });
  return {
    command: value,
    exitCode: result.exitCode,
    stderr: excerpt(result.stderr),
    stdout: excerpt(result.stdout),
  };
};

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

interface PackageManifest {
  name?: unknown;
}
const isPackageManifest = (value: unknown): value is PackageManifest =>
  value instanceof Object && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const candidatePackageName = (files: readonly SandboxProviderTargetFile[], appId: string) => {
  const manifest = files.find((file) => file.path === "package.json");
  if (manifest) {
    try {
      const parsed: unknown = JSON.parse(String(manifest.content));
      if (isPackageManifest(parsed) && isNonEmptyString(parsed.name)) {
        return parsed.name;
      }
    } catch {
      /* Candidate build reports malformed package metadata. */
    }
  }
  return `@autograph/${appId}`;
};

interface RuntimeProbe {
  id: "root" | "documentation";
  url: string;
  status: number | null;
  passed: boolean;
  detail: string;
  method: "browser" | "http";
  disposition: "observed" | "infrastructure-unavailable";
  readable?: boolean;
  returned?: boolean;
}

const parseRuntimeProbes = (text: string): RuntimeProbe[] => {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) {
    return [];
  }
  const probes: RuntimeProbe[] = [];
  for (const item of value) {
    if (isRuntimeProbe(item)) {
      probes.push(item);
    }
  }
  return probes;
};

const isRuntimeProbe = (value: unknown): value is RuntimeProbe => {
  if (!(value instanceof Object) || Array.isArray(value)) {
    return false;
  }
  const probe = value as RuntimeProbe;
  // SAFETY: Every required field is validated below before this parsed JSON value is returned as a probe.
  if (
    (probe.id !== "root" && probe.id !== "documentation") ||
    typeof probe.url !== "string" ||
    (probe.status !== null && typeof probe.status !== "number") ||
    typeof probe.passed !== "boolean" ||
    typeof probe.detail !== "string" ||
    (probe.method !== "browser" && probe.method !== "http") ||
    (probe.disposition !== "observed" && probe.disposition !== "infrastructure-unavailable")
  ) {
    return false;
  }
  return probe;
};

const runtimeBasePathFor = async (
  handle: CandidateRuntimeSandbox,
  input: Parameters<typeof evaluateCandidateRuntime>[0],
) => {
  try {
    const manifest = await handle.session.readTextFile({
      path: `apps/${input.candidateAppId}/.next/routes-manifest.json`,
    });
    const routes: unknown = JSON.parse(manifest ?? "{}");
    if (isRoutesManifest(routes)) {
      return routes.basePath;
    }
  } catch {
    // Custom output layouts retain the caller's explicit runtime path.
  }
  return input.publicBasePath;
};
interface RoutesManifest {
  basePath: string;
}
const isRoutesManifest = (value: unknown): value is RoutesManifest =>
  value instanceof Object &&
  !Array.isArray(value) &&
  isNonEmptyString(Reflect.get(value, "basePath"));

const collectStartupStream = async (
  stream: ReadableStream<Uint8Array> | ReadableStream<string>,
  startup: RuntimeCommandReceipt,
  key: "stdout" | "stderr",
) => {
  const decoder = new TextDecoder();
  try {
    await stream.pipeTo(
      new WritableStream({
        write(chunk: Uint8Array | string) {
          startup[key] = excerpt(
            startup[key] +
              (typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })),
          );
        },
      }),
    );
  } catch {
    // Shutdown may close the diagnostic stream.
  }
};

const parseRuntimeProbeOutput = (receipt: RuntimeCommandReceipt) =>
  receipt.exitCode === 0 ? parseRuntimeProbes(receipt.stdout.trim()) : [];

const makeCandidateSandbox = async (
  input: Parameters<typeof evaluateCandidateRuntime>[0],
): Promise<CandidateRuntimeSandbox> => {
  if (input.backend !== undefined) {
    return await input.backend.open();
  }
  const native = await Sandbox.create({
    ...input.credentials,
    image: "vcr.vercel.com/vercel/eve/base:0.68.0",
    name: `self-reproduction-runtime-${randomUUID()}`,
    networkPolicy: "allow-all",
  });
  await native.fs.mkdir("/workspace", { recursive: true });
  return {
    id: native.name,
    session: createVercelSdkSession(native),
    shutdown: async () => {
      await native.delete();
    },
  };
};

const writeCandidateFiles = async (
  handle: CandidateRuntimeSandbox,
  input: Parameters<typeof evaluateCandidateRuntime>[0],
) => {
  await Promise.all([
    ...input.files.map((file) =>
      handle.session.writeTextFile({
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
};

const runCandidateCommand = async (
  handle: CandidateRuntimeSandbox,
  commands: RuntimeCommandReceipt[],
  value: string,
  signal: AbortSignal,
) => {
  const receipt = await command(handle, value, signal);
  commands.push(receipt);
  return receipt;
};

const runCandidateBuild = async (
  handle: CandidateRuntimeSandbox,
  input: Parameters<typeof evaluateCandidateRuntime>[0],
  commands: RuntimeCommandReceipt[],
  signal: AbortSignal,
  runtimeEnvironment: string,
  bun: string,
) => {
  const runtime = await runCandidateCommand(
    handle,
    commands,
    developmentPinnedToolchainCommand(),
    signal,
  );
  if (runtime.exitCode !== 0) {
    return "Candidate runtime toolchain installation failed.";
  }
  const install = await runCandidateCommand(handle, commands, `${bun} install`, signal);
  if (install.exitCode !== 0) {
    return "Candidate dependency installation failed.";
  }
  const microfrontends = await runCandidateCommand(
    handle,
    commands,
    `${bun} .config/mise/scripts/repository/generate-microfrontends.ts`,
    signal,
  );
  if (microfrontends.exitCode !== 0) {
    return "Candidate microfrontend configuration failed.";
  }
  const registration = await runCandidateCommand(
    handle,
    commands,
    `${runtimeEnvironment} node .self-reproduction-register.mjs`,
    signal,
  );
  if (registration.exitCode !== 0) {
    return "Candidate microfrontend registration failed.";
  }
  const build = await runCandidateCommand(
    handle,
    commands,
    `VC_MICROFRONTENDS_CONFIG=/workspace/.scratch/microfrontends/microfrontends.json ${bun} run --cwd apps/${input.candidateAppId} build`,
    signal,
  );
  if (build.exitCode === 0) {
    return null;
  }
  if (input.debugPrerender === true) {
    await runCandidateCommand(
      handle,
      commands,
      `${runtimeEnvironment} node node_modules/next/dist/bin/next build apps/${input.candidateAppId} --debug-prerender`,
      signal,
    );
  }
  return "Candidate build failed.";
};

const addBrowserProbe = async (
  handle: CandidateRuntimeSandbox,
  input: Parameters<typeof evaluateCandidateRuntime>[0],
  commands: RuntimeCommandReceipt[],
  probes: RuntimeProbe[],
  controller: AbortController,
  runtimeEnvironment: string,
  bun: string,
  runtimeBasePath: string,
) => {
  const browserSetup = await command(
    handle,
    `${bun} x playwright install --with-deps chromium`,
    controller.signal,
  );
  commands.push(browserSetup);
  await input.onReady?.({
    abortSignal: controller.signal,
    baseURL: `http://127.0.0.1:3000${runtimeBasePath}`,
    session: handle.session,
  });
  const browser = await command(
    handle,
    `${runtimeEnvironment} node .self-reproduction-browser.mjs`,
    controller.signal,
  );
  commands.push(browser);
  if (browser.exitCode === 0) {
    probes.push(...parseRuntimeProbeOutput(browser));
    return;
  }
  probes.push({
    detail: `Evaluator browser was unavailable: ${browser.stderr || browser.stdout}`,
    disposition: "infrastructure-unavailable",
    id: "documentation",
    method: "browser",
    passed: false,
    status: null,
    url: `http://127.0.0.1:3000${runtimeBasePath}/docs`,
  });
};

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
  const rootText = (await page.locator("body").innerText()).trim();
  const response = await page.goto(baseURL + "/docs", { waitUntil: "domcontentloaded" });
  const body = (await page.locator("body").innerText()).trim();
  await page.goBack({ waitUntil: "domcontentloaded" });
  const returned = page.url() === rootURL;
  const readable = (response?.status() ?? 0) >= 200 && (response?.status() ?? 0) < 400 && body.length > 40 && body !== rootText;
  result = { id: "documentation", url: baseURL + "/docs", status: response?.status() ?? null, passed: readable && returned, readable, returned, detail: readable && returned ? "Public documentation rendered and browser back-navigation returned to the original page." : "Documentation readable=" + readable + "; return-navigation=" + returned + ".", method: "browser", disposition: "observed" };
} catch (error) {
  result = { id: "documentation", url: baseURL + "/docs", status: null, passed: false, detail: error instanceof Error ? error.message : "Browser probe failed.", method: "browser", disposition: "observed" };
} finally {
  await context.close();
  await browser.close();
}
console.log(JSON.stringify([result]));
`;

const startCandidateRuntime = async (
  handle: CandidateRuntimeSandbox,
  input: Parameters<typeof evaluateCandidateRuntime>[0],
  commands: RuntimeCommandReceipt[],
  controller: AbortController,
  runtimeEnvironment: string,
  bun: string,
): Promise<CandidateRuntimeReceipt> => {
  // A microfrontend's gateway prefix is not necessarily its direct Next basePath.
  const runtimeBasePath = await runtimeBasePathFor(handle, input);
  await handle.session.writeTextFile({
    content: readinessScript(runtimeBasePath),
    path: ".self-reproduction-readiness.mjs",
  });
  await handle.session.writeTextFile({
    content: browserProbeScript(runtimeBasePath),
    path: ".self-reproduction-browser.mjs",
  });
  const startCommand = `PORT=3000 ${bun} run --cwd apps/${input.candidateAppId} start`;
  const server = await handle.session.spawn({
    abortSignal: controller.signal,
    command: startCommand,
  });
  const startup: RuntimeCommandReceipt = {
    command: startCommand,
    exitCode: null,
    stderr: "",
    stdout: "",
  };
  commands.push(startup);
  // Drain both streams while readiness runs, retaining bounded startup diagnostics.
  void collectStartupStream(server.stdout, startup, "stdout");
  void collectStartupStream(server.stderr, startup, "stderr");
  const probe = await command(
    handle,
    `${runtimeEnvironment} node .self-reproduction-readiness.mjs`,
    controller.signal,
  );
  commands.push(probe);
  const probes: RuntimeProbe[] = parseRuntimeProbeOutput(probe);
  const root = probes.find((item) => item.id === "root");
  if (root?.passed === true) {
    await addBrowserProbe(
      handle,
      input,
      commands,
      probes,
      controller,
      runtimeEnvironment,
      bun,
      runtimeBasePath,
    );
  }
  return {
    commands,
    probes,
    producer: "evaluator",
    reason:
      root?.passed === true
        ? "Candidate runtime became ready."
        : "Candidate runtime was not reachable.",
    sandboxId: handle.id,
    status: root?.passed === true ? "available" : "failed",
  };
};

/** Starts an exported candidate in a fresh evaluator-owned Vercel Sandbox.
 * The generated application never receives the backend handle or probe code. */
export const evaluateCandidateRuntime = async (input: {
  files: readonly SandboxProviderTargetFile[];
  workspaceArchive: Buffer;
  candidateAppId: string;
  publicBasePath: string;
  credentials?: { token: string; teamId: string; projectId: string };
  appRoot?: string;
  backend?: CandidateRuntimeProvider;
  timeoutMs?: number;
  /** Opt-in diagnostic rebuild after failure; never used as acceptance evidence. */
  debugPrerender?: boolean;
  /** Evaluator work runs against loopback before the sandbox is released. */
  onReady?: (input: {
    session: CandidateRuntimeSandbox["session"];
    baseURL: string;
    abortSignal: AbortSignal;
  }) => Promise<void>;
}): Promise<CandidateRuntimeReceipt> => {
  const commands: RuntimeCommandReceipt[] = [];
  let handle: CandidateRuntimeSandbox | undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error("Candidate runtime deadline exceeded."));
  }, input.timeoutMs ?? 600_000);
  try {
    handle = await makeCandidateSandbox(input);
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
    if (unpack.exitCode !== 0) {
      return {
        commands,
        probes: [],
        producer: "evaluator",
        reason: "Reference workspace reconstruction failed.",
        sandboxId: handle.id,
        status: "failed",
      };
    }
    await writeCandidateFiles(handle, input);
    const runtimeEnvironment = Object.entries(DEVELOPMENT_SANDBOX_ENVIRONMENT)
      .map(([name, value]) => `${name}=${value}`)
      .join(" ");
    const bun = `${runtimeEnvironment} bun`;
    const buildFailure = await runCandidateBuild(
      handle,
      input,
      commands,
      controller.signal,
      runtimeEnvironment,
      bun,
    );
    if (buildFailure !== null) {
      return {
        commands,
        probes: [],
        producer: "evaluator",
        reason: buildFailure,
        sandboxId: handle.id,
        status:
          buildFailure === "Candidate runtime toolchain installation failed."
            ? "infrastructure-unavailable"
            : "failed",
      };
    }
    return await startCandidateRuntime(
      handle,
      input,
      commands,
      controller,
      runtimeEnvironment,
      bun,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const receipt: CandidateRuntimeReceipt = {
      commands: [],
      probes: [],
      producer: "evaluator",
      reason: message,
      status:
        handle === undefined && /credential|oidc|sandbox|network|fetch/iu.test(message)
          ? "infrastructure-unavailable"
          : "failed",
    };
    if (handle !== undefined) {
      receipt.sandboxId = handle.id;
    }
    return receipt;
  } finally {
    clearTimeout(timer);
    if (handle !== undefined) {
      try {
        await handle.shutdown();
      } catch {
        // The evaluator preserves the primary runtime outcome if cleanup fails.
      }
    }
  }
};
