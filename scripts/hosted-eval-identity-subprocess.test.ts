import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const launcher = path.join(root, ".config/mise/scripts/trusted-node-launcher");

it("trusted launcher transports hosted scope and identity file but excludes ambient bearer keys", () => {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    NODE_OPTIONS: undefined,
    SELF_REPRODUCTION_WORKLOAD_IDENTITY_FILE: "/tmp/synthetic-identity.json",
    VERCEL_ENV: "production",
    VERCEL_OIDC_TOKEN: "must-not-cross",
    VERCEL_PROJECT_ID: "prj_eval",
    VERCEL_TEAM_ID: "team_eval",
    VERCEL_TOKEN: "must-not-cross",
  };
  const expression = `console.log(JSON.stringify({file:process.env.SELF_REPRODUCTION_WORKLOAD_IDENTITY_FILE,project:process.env.VERCEL_PROJECT_ID,team:process.env.VERCEL_TEAM_ID,environment:process.env.VERCEL_ENV,token:process.env.VERCEL_OIDC_TOKEN??null,staticToken:process.env.VERCEL_TOKEN??null}))`;
  const result = spawnSync("/bin/sh", [launcher, process.execPath, "-e", expression], {
    cwd: root,
    encoding: "utf-8",
    env: environment,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    environment: "production",
    file: "/tmp/synthetic-identity.json",
    project: "prj_eval",
    staticToken: null,
    team: "team_eval",
    token: null,
  });
  const rejected = spawnSync("/bin/sh", [launcher, process.execPath, "-e", expression], {
    cwd: root,
    encoding: "utf-8",
    env: { ...environment, NODE_OPTIONS: "--trace-warnings" },
  });
  expect(rejected.status).toBe(78);
});

it("long-running real preload refreshes SDK identity and rejects correctly signed wrong-scope replacements", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "hosted-preload-process-"));
  const file = path.join(directory, "identity.json");
  const observations = path.join(directory, "observations.json");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    alg: "RS256",
    kid: "synthetic",
    use: "sig",
  };
  const token = (project: string, version: string) => {
    const now = Math.floor(Date.now() / 1000);
    const encoded = [
      { alg: "RS256", kid: "synthetic" },
      {
        environment: "production",
        exp: now + 120,
        iat: now,
        iss: "https://oidc.vercel.com",
        jti: version,
        nbf: now - 1,
        owner_id: "team_eval",
        project_id: project,
      },
    ]
      .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
      .join(".");
    return `${encoded}.${sign("RSA-SHA256", Buffer.from(encoded), privateKey).toString("base64url")}`;
  };
  const initial = token("prj_eval", "initial");
  const replacement = token("prj_eval", "replacement");
  const wrong = token("prj_wrong", "wrong");
  await writeFile(file, JSON.stringify({ token: initial }));
  const shim = path.join(directory, "jwks.mjs");
  await writeFile(
    shim,
    `import https from 'node:https';import {EventEmitter} from 'node:events';import {Readable} from 'node:stream';https.get=(url)=>{if(String(url)!=="https://oidc.vercel.com/.well-known/jwks")throw new Error("Unexpected network request");const request=new EventEmitter();process.nextTick(()=>{const response=Readable.from([Buffer.from(JSON.stringify({keys:[${JSON.stringify(jwk)}]}))]);response.statusCode=200;request.emit('response',response);});return request;};`,
  );
  const entry = path.join(directory, "child.mjs");
  const sdk = pathToFileURL(path.join(root, "node_modules/@vercel/oidc/dist/index.js")).href;
  await writeFile(
    entry,
    `import {writeFile} from 'node:fs/promises';import {getVercelOidcTokenSync} from ${JSON.stringify(sdk)};const values=[];setInterval(async()=>{const token=getVercelOidcTokenSync();const version=JSON.parse(Buffer.from(token.split('.')[1],'base64url')).jti;if(values.at(-1)!==version){values.push(version);await writeFile(${JSON.stringify(observations)},JSON.stringify(values));}},100);`,
  );
  const child = spawn(
    process.execPath,
    [
      "--import",
      shim,
      "--import",
      path.join(root, "scripts/hosted-eval-identity-preload.mjs"),
      entry,
    ],
    {
      cwd: root,
      env: {
        NODE_ENV: "test",
        PATH: "/usr/bin:/bin",
        SELF_REPRODUCTION_WORKLOAD_IDENTITY_FILE: file,
        VERCEL_ENV: "production",
        VERCEL_PROJECT_ID: "prj_eval",
        VERCEL_TEAM_ID: "team_eval",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  try {
    const values = async () => {
      if (child.exitCode !== null) throw new Error(stderr);
      return JSON.parse(await readFile(observations, "utf-8"));
    };
    await expect.poll(values, { timeout: 5000 }).toEqual(["initial"]);
    await writeFile(file, JSON.stringify({ token: replacement }));
    await expect.poll(values, { timeout: 5000 }).toEqual(["initial", "replacement"]);
    await writeFile(file, JSON.stringify({ token: wrong }));
    await delay(1500);
    expect(await values()).toEqual(["initial", "replacement"]);
    expect(child.exitCode, stderr).toBeNull();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill("SIGTERM");
      await closed;
    }
    await rm(directory, { force: true, recursive: true });
  }
}, 15_000);

it("trusted launcher preserves absent deployment metadata for local provider emulation", () => {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    NODE_OPTIONS: undefined,
    VERCEL_ENV: undefined,
    VERCEL_TARGET_ENV: undefined,
  };
  const result = spawnSync(
    "/bin/sh",
    [
      launcher,
      process.execPath,
      "-e",
      `console.log(JSON.stringify({environment:process.env.VERCEL_ENV??null,target:process.env.VERCEL_TARGET_ENV??null}))`,
    ],
    { cwd: root, encoding: "utf-8", env: environment },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ environment: null, target: null });
});
