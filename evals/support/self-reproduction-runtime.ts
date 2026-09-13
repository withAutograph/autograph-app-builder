import { randomUUID } from "node:crypto";

import type { SandboxBackend, SandboxBackendHandle, SandboxSeedFile } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";

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

const probeScript = (publicBasePath: string) => String.raw`
const basePath = ${JSON.stringify(publicBasePath)};
const targets = [["root", "http://127.0.0.1:3000" + basePath], ["documentation", "http://127.0.0.1:3000" + basePath + "/docs"]];
const deadline = Date.now() + 120000;
while (Date.now() < deadline) {
  try { if ((await fetch(targets[0][1])).status < 500) break; } catch {}
  await new Promise((resolve) => setTimeout(resolve, 500));
}
const probes = [];
for (const [id, url] of targets) {
  try {
    const response = await fetch(url, { redirect: "manual" });
    probes.push({ id, url, status: response.status, passed: response.status >= 200 && response.status < 400, detail: "Evaluator HTTP response." });
  } catch (error) {
    probes.push({ id, url, status: null, passed: false, detail: error instanceof Error ? error.message : "Request failed." });
  }
}
console.log(JSON.stringify(probes));
`;

/** Starts an exported candidate in a fresh evaluator-owned Vercel Sandbox.
 * The generated application never receives the backend handle or probe code. */
export async function evaluateCandidateRuntime(input: {
  files: readonly SandboxSeedFile[];
  workspaceArchive: Buffer;
  candidateAppId: string;
  publicBasePath: string;
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
    const backend = input.backend ?? vercel({ networkPolicy: "allow-all" });
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
    await Promise.all(
      input.files.map((file) =>
        handle!.session.writeTextFile({
          path: `apps/${input.candidateAppId}/${file.path}`,
          content: String(file.content),
        }),
      ),
    );
    const install = await command(handle, "mise run dependencies:install", controller.signal);
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
    const build = await command(
      handle,
      `mise run app:check-build ${input.candidateAppId}`,
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
      command: `bun run --cwd apps/${input.candidateAppId} start -- --hostname 127.0.0.1 --port 3000`,
      abortSignal: controller.signal,
    });
    const probe = await command(
      handle,
      `node --input-type=module --eval ${JSON.stringify(probeScript(input.publicBasePath))}`,
      controller.signal,
    );
    commands.push(probe);
    const probes = probe.exitCode === 0 ? JSON.parse(probe.stdout.trim()) : [];
    const root = Array.isArray(probes)
      ? probes.find((item: { id?: unknown }) => item.id === "root")
      : undefined;
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
