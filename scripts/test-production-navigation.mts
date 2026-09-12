import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { request } from "node:http";
import { connect, createServer } from "node:net";
import type { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const source = resolve(import.meta.dirname, "..");
const docker = process.argv.at(3) ?? "";
const dockerHost = process.argv.at(5) ?? "";
if (
  process.argv[2] !== "--docker" ||
  !docker?.startsWith("/") ||
  process.argv[4] !== "--docker-host" ||
  !dockerHost?.startsWith("unix:///")
) {
  throw new Error("Use mise run test:production-navigation.");
}
// Deliberately do not inherit credentials, deployment metadata or Node preloads.
const environment: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  CI: process.env.CI,
  LANG: process.env.LANG,
  NODE_ENV: "production",
  NEXT_TELEMETRY_DISABLED: "1",
};
const scratch = await mkdtemp(join(tmpdir(), "autograph-navigation-"));
console.log(`Production navigation workspace: ${scratch}`);
const snapshot = join(scratch, "source");
const id = randomBytes(8).toString("hex");
const databaseName = `autograph_navigation_${id}`;
const container = `autograph-navigation-${id}`;
console.log(`Production navigation database: ${container}`);
const artifactDirectory = join(source, ".artifacts/production-navigation");
const children = new Set<ChildProcess>();
let databaseStarted = false;
let cancelled = false;
const upgradedSockets = new Set<Duplex>();

function assertRunning() {
  if (cancelled) throw new Error("Production navigation was cancelled.");
}

async function runDocker(args: string[]) {
  assertRunning();
  return await execute(docker, ["--host", dockerHost, ...args]);
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    await closed;
  } finally {
    clearTimeout(force);
  }
}

async function run(command: string, args: string[], input?: string) {
  assertRunning();
  const child = spawn(command, args, {
    cwd: snapshot,
    env: environment,
    stdio: [input === undefined ? "ignore" : "pipe", "inherit", "inherit"],
  });
  children.add(child);
  if (input !== undefined) child.stdin?.end(input);
  try {
    const [code, signal] = await once(child, "close");
    if (code !== 0) throw new Error(`${command} exited with ${code ?? signal}`);
  } finally {
    children.delete(child);
  }
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback port.");
  server.close();
  await once(server, "close");
  return address.port;
}

const appPort = await freePort();
const tls = createHttpsServer();
async function interrupt() {
  cancelled = true;
  await Promise.allSettled([...children].map(stopChild));
}
// Both mise and its launcher may forward a signal; repeated delivery must not
// restore the default immediate exit while cleanup is still in progress.
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);

try {
  await mkdir(snapshot);
  const listed = await execute(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: source,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const files = [...new Set(listed.stdout.split("\0").filter(Boolean))].filter(
    (file) =>
      !/^(?:\.env|\.vercel\/|\.emulate\/|\.artifacts\/|node_modules\/|\.next\/|test-results\/|playwright-report\/)/u.test(
        file,
      ),
  );
  const copies = await Promise.allSettled(
    files.map(async (file) => {
      // Git also lists submodule directory entries; they are not app sources.
      const info = await lstat(join(source, file)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!info || info.isDirectory()) return;
      await mkdir(dirname(join(snapshot, file)), { recursive: true });
      await cp(join(source, file), join(snapshot, file), { dereference: false });
    }),
  );
  const failedCopy = copies.find((copy) => copy.status === "rejected");
  if (failedCopy?.status === "rejected") throw failedCopy.reason;
  assertRunning();
  await symlink(join(source, "node_modules"), join(snapshot, "node_modules"), "dir");
  // This marker is never written to the checkout or a deployable artifact.
  await writeFile(
    join(snapshot, "lib/testing/production-navigation-artifact.ts"),
    "export const productionNavigationArtifact: boolean = true;\n",
  );
  await mkdir(join(snapshot, "app/production-cache-probe"), { recursive: true });
  await cp(
    join(snapshot, "e2e/production-navigation/cache-probe.route.ts"),
    join(snapshot, "app/production-cache-probe/route.ts"),
  );
  await execute("/usr/bin/openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(scratch, "key.pem"),
    "-out",
    join(scratch, "cert.pem"),
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  tls.setSecureContext({
    key: await readFile(join(scratch, "key.pem")),
    cert: await readFile(join(scratch, "cert.pem")),
  });
  tls.on("request", (incoming, outgoing) => {
    const upstream = request(
      {
        hostname: "127.0.0.1",
        port: appPort,
        path: incoming.url,
        method: incoming.method,
        headers: incoming.headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => {
      outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(upstream);
    outgoing.on("close", () => upstream.destroy());
  });
  tls.on("upgrade", (incoming, socket, head) => {
    upgradedSockets.add(socket);
    const upstream = connect(appPort, "127.0.0.1", () => {
      upstream.write(
        `${incoming.method} ${incoming.url} HTTP/${incoming.httpVersion}\r\n${Object.entries(
          incoming.headers,
        )
          .map(([name, value]) => `${name}: ${value}`)
          .join("\r\n")}\r\n\r\n`,
      );
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => {
      upgradedSockets.delete(socket);
      upstream.destroy();
    });
  });
  assertRunning();
  tls.listen(0, "127.0.0.1");
  await once(tls, "listening");
  const address = tls.address();
  if (!address || typeof address === "string") throw new Error("Missing TLS port.");
  const origin = `https://localhost:${address.port}`;
  databaseStarted = true;
  await runDocker([
    "run",
    "--rm",
    "--detach",
    "--name",
    container,
    "--env",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "--env",
    `POSTGRES_DB=${databaseName}`,
    "--publish",
    "127.0.0.1::5432",
    "postgres@sha256:48c8ad3a7284b82be4482a52076d47d879fd6fb084a1cbfccbd551f9331b0e40",
  ]);
  const deadline = Date.now() + 60_000;
  while (true) {
    assertRunning();
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- database initialization must precede migrations
      await runDocker([
        "exec",
        container,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
        "-d",
        databaseName,
      ]);
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      // oxlint-disable-next-line eslint/no-await-in-loop -- bounded readiness polling
      await delay(500);
    }
  }
  const mapping = (await runDocker(["port", container, "5432/tcp"])).stdout.trim();
  const databasePort = Number(mapping.split(":").at(-1));
  if (!Number.isInteger(databasePort)) throw new Error("Missing database port.");
  const databaseUrl = `postgresql://postgres@127.0.0.1:${databasePort}/${databaseName}`;
  const secret = randomBytes(32).toString("hex");
  const flagsSecret = randomBytes(32).toString("base64url");
  Object.assign(environment, {
    APP_BUILDER_PRODUCTION_NAVIGATION_ORIGIN: origin,
    BETTER_AUTH_URL: `${origin}/api/auth`,
    MCP_RESOURCE_URL: `${origin}/mcp`,
    BETTER_AUTH_SECRET: secret,
    DATABASE_URL: databaseUrl,
    FLAGS_SECRET: flagsSecret,
    GITHUB_CLIENT_ID: "navigation-github-client",
    GITHUB_CLIENT_SECRET: "navigation-github-secret",
    VERCEL_AUTH_CLIENT_ID: "navigation-vercel-client",
    VERCEL_AUTH_CLIENT_SECRET: "navigation-vercel-secret",
  });
  await writeFile(
    join(snapshot, ".navigation-fixture.json"),
    JSON.stringify({ origin, databaseUrl, secret, flagsSecret }),
    { mode: 0o600 },
  );
  await run(
    process.execPath,
    ["--import", "tsx", "lib/db/migrate.mts", "--database-url-fd", "0"],
    databaseUrl,
  );
  console.log("Building isolated production navigation artifact.");
  await run(process.execPath, ["node_modules/next/dist/bin/next", "build", "--webpack"]);
  const server = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(appPort),
    ],
    {
      cwd: snapshot,
      env: environment,
      stdio: "inherit",
    },
  );
  children.add(server);
  const readyDeadline = Date.now() + 60_000;
  while (true) {
    assertRunning();
    if (server.exitCode !== null) throw new Error("Production server exited before readiness.");
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- wait for the production server before browser assertions
      const response = await fetch(`http://127.0.0.1:${appPort}/github/installations`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) break;
    } catch {
      /* readiness is bounded below */
    }
    if (Date.now() >= readyDeadline) throw new Error("Production server readiness timed out.");
    // oxlint-disable-next-line eslint/no-await-in-loop -- bounded readiness polling
    await delay(250);
  }
  await run(process.execPath, [
    "node_modules/playwright/cli.js",
    "test",
    "--config=playwright.production-navigation.config.ts",
    ...process.argv.slice(6),
  ]);
} finally {
  await Promise.all([...children].map(stopChild));
  for (const socket of upgradedSockets) socket.destroy();
  tls.closeAllConnections();
  tls.close();
  try {
    if (databaseStarted) await execute(docker, ["--host", dockerHost, "rm", "-f", container]);
    await mkdir(artifactDirectory, { recursive: true });
    try {
      await cp(join(snapshot, "test-results/production-navigation"), artifactDirectory, {
        recursive: true,
      });
    } catch {
      /* no browser artifacts before test startup */
    }
  } finally {
    // Only remove the exact task-owned temporary directory returned by mkdtemp.
    await rm(scratch, { recursive: true, force: true });
  }
}
