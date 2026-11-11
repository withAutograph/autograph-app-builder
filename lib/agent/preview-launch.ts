import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";
import { describeSelectedApp } from "../repository/app-description";
import { describedBrowserEntryPath } from "../repository/browser-entry-path";
import { resolvePreviewPackageManager } from "./preview-package-manager";
import { resolvePreviewWorkingDirectory } from "./preview-working-directory";

const packageManifest = z.object({
  packageManager: z.string().optional(),
  scripts: z.record(z.string(), z.string()).optional(),
});
const previewPort = z.number().int().min(1024).max(65_535);
const packageManagers = ["bun", "pnpm", "npm", "yarn"] as const;
type PackageManager = (typeof packageManagers)[number];
const parsePackageManager = (value: string | undefined) =>
  packageManagers.find((manager) => value?.split("@")[0] === manager);

const portCommands: Record<PackageManager, string> = {
  bun: "bun run microfrontends port",
  pnpm: "pnpm exec microfrontends port",
  npm: "npm exec --no -- microfrontends port",
  yarn: "yarn run microfrontends port",
};
export interface PreviewLaunchRequest {
  command?: { executable: string; args: string[] };
  landingPath?: string;
  port?: number;
  workingDirectory: string;
}

interface ResolvedPreviewLaunch {
  command: NonNullable<PreviewLaunchRequest["command"]>;
  adjustment?: string;
  cwd: string;
  landingPath: string;
  port: number;
  portCommand?: string;
}

/** Prefer the app's repository-owned launch settings. Explicit commands remain available. */
export const resolvePreviewLaunch = async (input: {
  appId: string;
  root: string;
  sandbox: Pick<SandboxSession, "readTextFile" | "run">;
  request: PreviewLaunchRequest;
  identity?: { workspacePath: string; routes: readonly string[] };
  signal?: AbortSignal;
}): Promise<ResolvedPreviewLaunch> => {
  const { request, root, sandbox } = input;
  const rootManifest = await sandbox.readTextFile({ path: `${root}/package.json` });
  const savedEntryPath =
    input.identity === undefined ? null : describedBrowserEntryPath(input.identity);
  if (request.command !== undefined) {
    return {
      ...resolvePreviewPackageManager(request.command, rootManifest),
      cwd: resolvePreviewWorkingDirectory(root, request.workingDirectory),
      landingPath: request.landingPath ?? savedEntryPath ?? "/",
      port: request.port ?? 3000,
    };
  }
  let app = input.identity;
  if (app === undefined) {
    const { app: describedApp } = await describeSelectedApp(input);
    app = describedApp;
  }
  const landingPath = request.landingPath ?? describedBrowserEntryPath(app);
  if (landingPath === null) {
    throw new Error("Choose a registered app route to open this private preview.");
  }
  const cwd = resolvePreviewWorkingDirectory(root, app.workspacePath);
  const appManifest = await sandbox.readTextFile({ path: `${cwd}/package.json` });
  const workspace = appManifest === null ? {} : packageManifest.parse(JSON.parse(appManifest));
  const repository = rootManifest === null ? {} : packageManifest.parse(JSON.parse(rootManifest));
  const manager =
    parsePackageManager(repository.packageManager ?? workspace.packageManager) ?? "bun";
  const devScript = workspace.scripts?.dev ?? "";
  const fixedPort = /(?:^|\s)(?:--port[=\s]|-p\s)(?<port>\d{4,5})(?:\s|$)/u.exec(devScript)?.groups
    ?.port;
  const parsedPort = previewPort.safeParse(Number(fixedPort));
  const port = request.port ?? (parsedPort.success ? parsedPort.data : 3000);
  const launch: ResolvedPreviewLaunch = {
    command: { executable: manager, args: ["run", "dev"] },
    cwd,
    landingPath,
    port,
  };
  if (request.port === undefined && /\bmicrofrontends\s+port\b/u.test(devScript)) {
    launch.portCommand = portCommands[manager];
  }
  return launch;
};

/** Run the same port lookup used by the app script after workspace dependencies are present. */
export const resolvePreviewLaunchPort = async (
  launch: { cwd: string; port: number; portCommand?: string },
  sandbox: Pick<SandboxSession, "run">,
  signal: AbortSignal,
): Promise<number> => {
  if (launch.portCommand === undefined) {
    return launch.port;
  }
  const result = await sandbox.run({
    command: launch.portCommand,
    workingDirectory: launch.cwd,
    abortSignal: signal,
  });
  signal.throwIfAborted();
  const port = previewPort.safeParse(Number(result.stdout.trim()));
  if (result.exitCode !== 0 || !port.success) {
    throw new Error(
      "The repository's microfrontends port command did not return a port for this app. Check its local app registration before restarting preview.",
    );
  }
  return port.data;
};
