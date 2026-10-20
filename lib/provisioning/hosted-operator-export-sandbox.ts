import { Sandbox } from "@vercel/sandbox";
import { getVercelOidcToken } from "@vercel/oidc";
import { HostedOperatorError } from "./hosted-operator-contract";
import { hostedOperatorSandboxSourceOptions } from "./hosted-operator-sandbox-source";
import type { HostedOperatorSandboxSource } from "./hosted-operator-sandbox-source";
import { tenantExportWorkerDescriptorSchema } from "./hosted-operator-export-contract";
import type {
  TenantExportWorkerDescriptor,
  TenantExportWorkerInput,
} from "./hosted-operator-export-contract";
import type {
  TenantExportPrivateSource,
  TenantExportWorkerLocator,
} from "./hosted-operator-export";

const unavailable = () => new HostedOperatorError("reconciliation_required");
const inputPath = (worker: TenantExportWorkerInput) =>
  `/tmp/autograph-tenant-export-input/${worker.exportId}/${worker.attemptId}.json`;
const outputPath = (worker: TenantExportWorkerInput) =>
  `/tmp/autograph-tenant-export/${worker.exportId}/${worker.attemptId}`;
// Fixed private metadata writer; no shell, caller source, credentials, or business rows.
const exportMetadataWriter = `
const fs = require('node:fs');
const path = require('node:path');
const target = process.argv[1];
const content = process.argv[2];
const root = '/tmp/autograph-tenant-export-input';
for (const directory of [root, path.dirname(target)]) {
  try { fs.mkdirSync(directory, {mode: 0o700}); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) process.exit(1);
}
let handle;
try { handle = fs.openSync(target, 'wx', 0o600); }
catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const info = fs.lstatSync(target);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600 || fs.readFileSync(target, 'utf8') !== content) process.exit(1);
  process.exit(0);
}
try { fs.writeFileSync(handle, content); fs.fsyncSync(handle); }
finally { fs.closeSync(handle); }
`;
export type TenantExportSandboxConfiguration = HostedOperatorSandboxSource & {
  projectId: string;
  teamId: string;
  exportWorker?: TenantExportWorkerDescriptor;
};
export interface TenantExportSandboxCommand {
  cmdId: string;
  exitCode: number | null;
  stdout: () => Promise<string>;
  wait: () => Promise<{ exitCode: number }>;
}
export interface TenantExportSandboxPort {
  name: string;
  runCommand: (input: {
    cmd: string;
    args?: string[];
    env?: Record<string, string>;
    detached?: boolean;
  }) => Promise<TenantExportSandboxCommand>;
  getCommand: (commandId: string) => Promise<{ exitCode: number | null }>;
  readFileToBuffer: (input: { path: string }) => Promise<Buffer | null>;
  readFile: (input: { path: string }) => Promise<NodeJS.ReadableStream | null>;
  delete: () => Promise<void>;
  extendTimeout: (duration: number) => Promise<void>;
}
export const createTenantExportSandbox = (
  configuration: TenantExportSandboxConfiguration,
  dependencies: {
    create?: (options: Parameters<typeof Sandbox.create>[0]) => Promise<TenantExportSandboxPort>;
    get?: (options: Parameters<typeof Sandbox.get>[0]) => Promise<TenantExportSandboxPort>;
    token?: typeof getVercelOidcToken;
  } = {},
) => {
  const create = dependencies.create ?? (async (options) => await Sandbox.create(options));
  const get = dependencies.get ?? (async (options) => await Sandbox.get(options));

  const credentials = async () => ({
    projectId: configuration.projectId,
    teamId: configuration.teamId,
    token: await (dependencies.token ?? getVercelOidcToken)({
      project: configuration.projectId,
      team: configuration.teamId,
    }),
  });
  const reconnect = async (locator: TenantExportWorkerLocator) =>
    await get({ name: locator.sandboxId, resume: false, ...(await credentials()) });
  const source = (
    sandbox: TenantExportSandboxPort,
    worker: TenantExportWorkerInput,
  ): TenantExportPrivateSource => ({
    async readManifest() {
      const bytes = await sandbox.readFileToBuffer({ path: `${outputPath(worker)}/manifest.json` });
      if (bytes === null) {
        throw unavailable();
      }
      return bytes;
    },
    async *readMember(name) {
      if (!/^table-[0-9]+\.ndjson$/u.test(name)) {
        throw unavailable();
      }
      const stream = await sandbox.readFile({ path: `${outputPath(worker)}/${name}` });
      if (stream === null) {
        throw unavailable();
      }
      // SAFETY: SDK readFile returns a binary byte stream; no text or model transport is involved.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SDK byte-stream boundary has no row parsing or text coercion.
      for await (const chunk of stream as AsyncIterable<Uint8Array>) {
        yield chunk;
      }
    },
  });
  return {
    async prepare(worker: TenantExportWorkerInput, assertCurrent: () => Promise<void>) {
      const descriptor = tenantExportWorkerDescriptorSchema.parse(configuration.exportWorker);
      await assertCurrent();
      const sandbox = await create({
        ...hostedOperatorSandboxSourceOptions(configuration),
        ...(await credentials()),
        persistent: false,
        ports: [],
        env: {},
        networkPolicy: "allow-all",
        timeout: 300_000,
      });
      try {
        await assertCurrent();
        const checked = await sandbox.runCommand({
          cmd: "sha256sum",
          args: ["--", descriptor.executablePath],
          env: {},
        });
        const pin = await checked.stdout();
        if (checked.exitCode !== 0 || pin.split(/\s+/u)[0] !== descriptor.sha256) {
          throw new HostedOperatorError("resource_mismatch");
        }
        const metadata = JSON.stringify(worker);
        let preparationCode: number | null;
        try {
          const preparation = await sandbox.runCommand({
            cmd: "node",
            args: ["-e", exportMetadataWriter, inputPath(worker), metadata],
            env: {},
          });
          preparationCode = preparation.exitCode;
        } catch {
          const observed = await sandbox.readFileToBuffer({ path: inputPath(worker) });
          if (observed === null || !observed.equals(Buffer.from(metadata))) {
            throw unavailable();
          }
          preparationCode = 0;
        }
        if (preparationCode !== 0) {
          throw unavailable();
        }
        await assertCurrent();
        return { sandboxId: sandbox.name, descriptor };
      } catch {
        await sandbox.delete();
        throw unavailable();
      }
    },
    async inspect(
      worker: TenantExportWorkerInput,
      locator: TenantExportWorkerLocator | undefined,
    ): Promise<{ status: "terminal"; source?: TenantExportPrivateSource } | { status: "unknown" }> {
      if (locator?.commandId === undefined) {
        return { status: "unknown" };
      }
      try {
        const sandbox = await reconnect(locator);
        // Exported SDK command lookup reads the retained command; it never dispatches it again.
        const command = await sandbox.getCommand(locator.commandId);
        if (command.exitCode === null) {
          return { status: "unknown" };
        }
        const manifest = await sandbox.readFileToBuffer({
          path: `${outputPath(worker)}/manifest.json`,
        });
        return manifest === null
          ? { status: "terminal" }
          : { status: "terminal", source: source(sandbox, worker) };
      } catch {
        return { status: "unknown" };
      }
    },
    async dispose(locator: TenantExportWorkerLocator) {
      const sandbox = await reconnect(locator);
      await sandbox.delete();
    },
    async run(
      worker: TenantExportWorkerInput,
      locator: TenantExportWorkerLocator,
      migrationUrl: string,
      assertCurrent: () => Promise<void>,
      checkpoint: (locator: TenantExportWorkerLocator) => Promise<void>,
    ) {
      const sandbox = await reconnect(locator);
      await assertCurrent();
      const command = await sandbox.runCommand({
        cmd: locator.descriptor.executablePath,
        args: [locator.descriptor.subcommand, "--file-spool", inputPath(worker)],
        env: { AUTOGRAPH_TENANT_EXPORT_APP_MIGRATOR_URL: migrationUrl },
        detached: true,
      });
      // Unknown dispatch acknowledgement cannot be called terminal; the prior locator remains private.
      await checkpoint({ ...locator, commandId: command.cmdId });
      let renewalActive = false;
      const renewal = setInterval(() => {
        if (renewalActive) {
          return;
        }
        renewalActive = true;
        void (async () => {
          try {
            await assertCurrent();
            await sandbox.extendTimeout(300_000);
          } catch {
            await sandbox.delete();
          } finally {
            renewalActive = false;
          }
        })();
      }, 30_000);
      try {
        const result = await command.wait();
        if (result.exitCode !== 0) {
          throw unavailable();
        }
        await assertCurrent();
        return source(sandbox, worker);
      } finally {
        clearInterval(renewal);
      }
    },
  };
};
