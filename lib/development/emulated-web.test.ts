/* oxlint-disable promise/avoid-new -- Bridge local TLS server callbacks in integration fixtures. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:https";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { localCaFetch, prepareDevelopmentEmulatedWeb } from "./emulated-web";

// oxlint-disable-next-line typescript/strict-void-return -- Adapt Node overloaded callback API with promisify.
const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
  roots.length = 0;
});
const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "emulated-web-test-"));
  roots.push(root);
  const cert = path.join(root, "cert.pem");
  const key = path.join(root, "key.pem");
  await execute("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost",
  ]);
  return { cert, key, root };
};

it("verifies the configured local CA and refuses other origins", async () => {
  const { root, cert, key } = await fixture();
  const server = createServer(
    { cert: await readFile(cert), key: await readFile(key) },
    (_req, res) => {
      res.end("ready");
    },
  );
  await new Promise<void>((resolve) => {
    server.listen(0, "localhost", resolve);
  });
  try {
    const address = server.address();
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node returns a pipe string or TCP address.
    if (address === null || typeof address === "string") {
      throw new Error("No TCP fixture address");
    }
    const origin = `https://localhost:${address.port}`;
    const fetcher = localCaFetch(origin, await readFile(cert, "utf-8"));
    const response = await fetcher(origin);
    expect(await response.text()).toBe("ready");
    await expect(fetcher("https://example.test")).rejects.toThrow("another origin");
    const other = await fixture();
    await expect(
      localCaFetch(origin, await readFile(other.cert, "utf-8"))(origin),
    ).rejects.toThrow();
    expect(root).not.toBe(other.root);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
});

it("retains external state and stops only its owned preparation process", async () => {
  const { root, cert, key } = await fixture();
  const repositoryRoot = path.join(root, "repo");
  const stateRoot = path.join(root, "state");
  await mkdir(path.join(repositoryRoot, ".config/mise/tasks/app"), { recursive: true });
  const entry = path.join(repositoryRoot, ".config/mise/tasks/app/dev-emulated");
  const miseBinary = path.join(root, "mise");
  await writeFile(miseBinary, '#!/bin/sh\nshift 2\nexec "$@"\n', { mode: 0o700 });
  await writeFile(
    entry,
    `#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');fs.writeFileSync(path.join(process.env.APP_BUILDER_EMULATED_STATE_ROOT,'environment.json'),JSON.stringify({BETTER_AUTH_URL:'https://localhost:3000/api/auth'}));fs.writeFileSync(path.join(process.env.APP_BUILDER_EMULATED_STATE_ROOT,'pid'),String(process.pid));setInterval(()=>{},1000);`,
    { mode: 0o700 },
  );
  const prepared = await prepareDevelopmentEmulatedWeb({
    args: {
      arrustedRoot: root,
      emulatedWeb: true,
      evePort: 2000,
      nextPort: 3000,
      webCa: cert,
      webCertificate: cert,
      webKey: key,
    },
    miseBinary,
    repositoryRoot,
    signal: new AbortController().signal,
    stateRoot,
  });
  const pid = Number(await readFile(path.join(stateRoot, "emulated-web/pid"), "utf-8"));
  expect(prepared.origin).toBe("https://localhost:3000");
  expect(prepared.nextArgs).toContain(path.join(stateRoot, "emulated-web/localhost-key.pem"));
  expect(prepared.environment).not.toHaveProperty("EVE_HOSTED_ADAPTER");
  await prepared.stop();
  expect(() => process.kill(pid, 0)).toThrow();
  await expect(readFile(path.join(stateRoot, "emulated-web/environment.json"))).rejects.toThrow();
  await writeFile(entry, "#!/bin/sh\nexit 3\n", { mode: 0o700 });
  await expect(
    prepareDevelopmentEmulatedWeb({
      args: {
        arrustedRoot: root,
        emulatedWeb: true,
        evePort: 2000,
        nextPort: 3000,
        webCa: cert,
        webCertificate: cert,
        webKey: key,
      },
      miseBinary,
      repositoryRoot,
      signal: new AbortController().signal,
      stateRoot,
    }),
  ).rejects.toThrow("preparation failed");
});
