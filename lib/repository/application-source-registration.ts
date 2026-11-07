import { setBuilderSandboxNetworkPolicy } from "../sandbox/builder-sandbox";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { SandboxSession } from "eve/sandbox";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const applicationSourceRegistrationSchema = z.strictObject({
  assetRoute: z.string(),
  newDigest: digest,
  oldDigest: digest,
  projectName: z.string(),
  proposedBytes: z.string(),
});
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
const repositoryRoot = "/workspace/repository";

/** Invoke the acquired platform's pure planner; no uploaded app module is imported. */
export const planApplicationSourceRegistration = async (
  sandbox: SandboxSession,
  appId: string,
  configBytes?: string,
) => {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(appId)) {
    throw new Error("Invalid imported app identity.");
  }
  const packageName = `@autograph/${appId}`;
  const routes = [`/${appId}`, `/${appId}/:path*`];
  const source = `import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';import {planMicrofrontendRegistration} from './packages/platform-microfrontends/src/policy/config-registration.ts';const bytes=${configBytes === undefined ? "readFileSync('microfrontends.json','utf8')" : JSON.stringify(configBytes)}; console.log(JSON.stringify(planMicrofrontendRegistration(bytes,{projectName:${JSON.stringify(appId)},packageName:${JSON.stringify(packageName)},routes:${JSON.stringify(routes)},expectedDigest:createHash('sha256').update(bytes).digest('hex')})));`;
  let result = await sandbox.run({
    command: `bun -e ${quote(source)}`,
    workingDirectory: repositoryRoot,
  });
  if (
    result.exitCode !== 0 &&
    /cannot find module|module_not_found|node_modules|dependencies? (?:are )?missing/iu.test(
      `${result.stdout}\n${result.stderr}`,
    )
  ) {
    await setBuilderSandboxNetworkPolicy(sandbox, "allow-all");
    const dependencies = await sandbox.run({
      command: "bun install --ignore-scripts --filter @autograph/platform-microfrontends",
      workingDirectory: repositoryRoot,
    });
    if (dependencies.exitCode !== 0) {
      throw new Error("The platform registration planner dependencies are unavailable.");
    }
    result = await sandbox.run({
      command: `bun -e ${quote(source)}`,
      workingDirectory: repositoryRoot,
    });
  }
  if (result.exitCode !== 0) {
    throw new Error("The acquired platform could not plan the imported app registration.");
  }
  const parsed = applicationSourceRegistrationSchema.parse(JSON.parse(result.stdout));
  if (
    parsed.projectName !== appId ||
    createHash("sha256").update(parsed.proposedBytes).digest("hex") !== parsed.newDigest
  ) {
    throw new Error("Imported app registration plan mismatch.");
  }
  return parsed;
};
