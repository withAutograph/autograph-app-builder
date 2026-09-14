/* oxlint-disable eslint/no-await-in-loop -- Poll one owned preparation process sequentially. */
/* oxlint-disable promise/avoid-new, sonarjs/no-nested-functions -- Bridge scoped HTTPS request events to the Fetch readiness interface. */
import { getCacheDirectory } from "next/dist/lib/helpers/get-cache-directory";
import { promisify } from "node:util";
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, readdir, chmod } from "node:fs/promises";
import { request } from "node:https";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { DevelopmentArguments } from "./local-mode";
import { stopEmulatedWebServices } from "./emulated-web-stop";
import { developmentChildExit } from "./process-supervisor";

// oxlint-disable-next-line typescript/strict-void-return -- Adapt Node overloaded callback API with promisify.
const execFileAsync = promisify(execFile);
const caName = "rootCA.pem";

export const emulatedWebEnvironmentKeys = [
  "APP_BUILDER_LOCAL_PROVIDER_EMULATION",
  "APP_BUILDER_LOCAL_AUTH_EMULATION",
  "APP_BUILDER_LOCAL_PORT",
  "APP_BUILDER_DATABASE_PORT",
  "PASSKEY_ONBOARDING",
  "BETTER_AUTH_URL",
  "MCP_RESOURCE_URL",
  "BETTER_AUTH_SECRET",
  "FLAGS_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_INSTALL_STATE_SECRET",
  "VERCEL_AUTH_CLIENT_ID",
  "VERCEL_AUTH_CLIENT_SECRET",
  "VERCEL_INTEGRATION_SLUG",
  "VERCEL_INTEGRATION_CLIENT_ID",
  "VERCEL_INTEGRATION_CLIENT_SECRET",
  "VERCEL_INTEGRATION_TOKEN_KEY",
  "VERCEL_INTEGRATION_TOKEN_KEY_VERSION",
  "VERCEL_EMULATOR_URL",
  "GITHUB_EMULATOR_URL",
  "EMULATE_PROVIDER_TOKEN",
  "EMULATE_VERCEL_CONFIGURATION_ID",
  "EMULATE_VERCEL_TEAM_ID",
  "EMULATE_GITHUB_INSTALLATION_ID",
  "EMULATE_GITHUB_REPOSITORY",
  "EMULATE_LOCAL_RELAY_SECRET",
] as const;

/** Scoped CA verification for this development endpoint only; never disables TLS. */
export const localCaFetch =
  (origin: string, ca: string): typeof fetch =>
  async (input, init) => {
    const target = input instanceof Request ? input.url : input;
    const url = new URL(target);
    if (url.origin !== origin) {
      throw new Error("Local CA readiness cannot contact another origin.");
    }
    return await new Promise<Response>((resolve, reject) => {
      const req = request(
        url,
        {
          ca,
          headers: Object.fromEntries(new Headers(init?.headers)),
          method: init?.method,
          signal: init?.signal ?? undefined,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
          });
          res.on("end", () => {
            const status = res.statusCode ?? 500;
            resolve(
              new Response(status === 204 ? null : Buffer.concat(chunks), {
                headers: Object.fromEntries(
                  Object.entries(res.headers).flatMap(([key, value]) =>
                    value === undefined
                      ? []
                      : [[key, Array.isArray(value) ? value.join(", ") : value]],
                  ),
                ),
                status,
              }),
            );
          });
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      if (init?.body !== undefined && init.body !== null) {
        const body = z.string().safeParse(init.body);
        if (!body.success) {
          req.destroy();
          reject(new Error("Readiness expects a JSON string body."));
          return;
        }
        req.write(body.data);
      }
      req.end();
    });
  };

export const cachedCertificateAuthority = async (cache: string) => {
  const entries = await readdir(cache);
  const binaries = entries
    .toSorted((left, right) => right.localeCompare(left, undefined, { numeric: true }))
    .filter((name) => name.startsWith("mkcert-") && name.includes(process.platform));
  for (const binary of binaries) {
    try {
      const result = await execFileAsync(path.join(cache, binary), ["-CAROOT"]);
      const ca = path.join(result.stdout.trim(), caName);
      await readFile(ca);
      return ca;
    } catch {
      // An old or incompatible cached executable does not prevent using another installed one.
    }
  }
  throw new Error("No installed cached mkcert could identify an existing local CA.");
};

const existingCertificateAuthority = async (override?: string) => {
  let caSource =
    override ??
    (process.env.CAROOT === undefined ? undefined : path.join(process.env.CAROOT, caName));
  if (caSource === undefined) {
    try {
      const cache = getCacheDirectory("mkcert");
      caSource = await cachedCertificateAuthority(cache);
    } catch {
      throw new Error(
        "Existing trusted local CA unavailable. Supply --web-ca and existing --web-certificate/--web-key; no system trust installation is performed.",
      );
    }
  }
  return caSource;
};

export const prepareDevelopmentEmulatedWeb = async (input: {
  args: DevelopmentArguments;
  repositoryRoot: string;
  stateRoot: string;
  signal: AbortSignal;
  miseBinary?: string;
}) => {
  const { args } = input;
  const certificateSource =
    args.webCertificate ?? path.join(input.repositoryRoot, "certificates/localhost.pem");
  const keySource =
    args.webKey ?? path.join(input.repositoryRoot, "certificates/localhost-key.pem");
  const caSource = await existingCertificateAuthority(args.webCa);
  const root = path.join(input.stateRoot, "emulated-web");
  await mkdir(root, { mode: 0o700, recursive: true });
  const cert = path.join(root, "localhost.pem");
  const key = path.join(root, "localhost-key.pem");
  const ca = path.join(root, caName);
  try {
    await Promise.all([
      copyFile(certificateSource, cert),
      copyFile(keySource, key),
      copyFile(caSource, ca),
    ]);
    await Promise.all([chmod(cert, 0o600), chmod(key, 0o600), chmod(ca, 0o600)]);
  } catch {
    throw new Error(
      "Existing localhost TLS files unavailable. Reuse trusted certificates or supply --web-certificate, --web-key and --web-ca. No system trust changes are made.",
    );
  }
  const receipt = path.join(root, "environment.json");
  await rm(receipt, { force: true });
  const origin = `https://localhost:${args.nextPort}`;
  const miseBinary = input.miseBinary ?? process.env.APP_BUILDER_DEV_MISE_BIN;
  if (miseBinary === undefined || !path.isAbsolute(miseBinary)) {
    throw new Error(
      "mise dev must provide the installed mise executable for emulated web preparation.",
    );
  }
  const service = spawn(
    miseBinary,
    ["exec", "--", path.join(input.repositoryRoot, ".config/mise/tasks/app/dev-emulated")],
    {
      cwd: input.repositoryRoot,
      detached: true,
      env: {
        ...process.env,
        APP_BUILDER_DATABASE_CONTAINER: `autograph-development-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`,
        APP_BUILDER_EMULATED_SERVICES_ONLY: "1",
        APP_BUILDER_EMULATED_STATE_ROOT: root,
        APP_BUILDER_LOCAL_PORT: String(args.nextPort),
      },
      stdio: "inherit",
    },
  );
  let startupError: Error | undefined;
  service.on("error", (error) => {
    startupError = error;
  });
  const stop = async () => {
    await stopEmulatedWebServices(service);
    await rm(receipt, { force: true });
  };
  try {
    const deadline = Date.now() + 120_000;
    while (true) {
      input.signal.throwIfAborted();
      if (startupError !== undefined) {
        throw startupError;
      }
      if (service.exitCode !== null || service.signalCode !== null) {
        throw new Error(
          "Emulated web preparation failed; inspect local Docker, migrations and provider emulator diagnostics.",
        );
      }
      try {
        const environment = z
          .record(z.string(), z.string())
          .parse(JSON.parse(await readFile(receipt, "utf-8")));
        return {
          environment: { ...environment, NODE_EXTRA_CA_CERTS: ca },
          exited: developmentChildExit(service),
          fetcher: localCaFetch(origin, await readFile(ca, "utf-8")),
          nextArgs: [
            "--experimental-https",
            "--experimental-https-key",
            key,
            "--experimental-https-cert",
            cert,
            "--experimental-https-ca",
            ca,
          ],
          origin,
          stop,
        };
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error("Emulated web setup timed out; inspect the owned local services.");
      }
      await delay(100, undefined, { signal: input.signal });
    }
  } catch (error) {
    await stop();
    throw error;
  }
};
