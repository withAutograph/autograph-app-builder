import type { Sandbox } from "@vercel/sandbox";
import { z } from "zod";

import { HostedRuntimeCommandError } from "./hosted-runtime-service";
import type { HostedRuntimeExecutor } from "./hosted-runtime-service";
import { hostedRuntimeProofSchema } from "./hosted-runtime-journal";

type HostedRuntimeSandboxTransport = Pick<Sandbox, "runCommand" | "writeFiles"> & {
  fs: Pick<Sandbox["fs"], "mkdir" | "readFile" | "readdir">;
};

/** Protected files and env go through the official Sandbox SDK, never shell text or tool output. */
export const createHostedRuntimeSandboxExecutor = (input: {
  appId: string;
  authOrigin?: string;
  provider: HostedRuntimeSandboxTransport;
  root: string;
  stateDirectory: string;
  roles?: readonly string[];
  signal?: AbortSignal;
}): HostedRuntimeExecutor => ({
  async capture() {
    const names = await input.provider.fs.readdir(input.stateDirectory, { signal: input.signal });
    const files: Record<string, string> = {};
    for (const name of names.filter((candidate) => /^[A-Za-z0-9_.-]+\.json$/u.test(candidate))) {
      // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- apply provider backpressure without a total file cap.
      files[name] = await input.provider.fs.readFile(`${input.stateDirectory}/${name}`, {
        encoding: "utf-8",
        signal: input.signal,
      });
    }
    return files;
  },
  async restore(files) {
    await input.provider.fs.mkdir(input.stateDirectory, { recursive: true, signal: input.signal });
    await input.provider.writeFiles(
      Object.entries(files).map(([name, content]) => ({
        content,
        mode: 0o600,
        path: `${input.stateDirectory}/${name}`,
      })),
      { signal: input.signal },
    );
  },
  async run({ clusterUrl, operation, productionDatabaseIdentity, runtimeId, signal }) {
    const env = {
      APP_RUNTIME_AUTH_ORIGIN: input.authOrigin ?? "",
      APP_RUNTIME_CLUSTER_DATABASE_URL: clusterUrl,
      APP_RUNTIME_ID: runtimeId,
      APP_RUNTIME_ROLES: input.roles?.join(",") ?? "",
      APP_RUNTIME_STATE_DIR: input.stateDirectory,
      AUTH_PRODUCTION_DATABASE_IDENTITY: productionDatabaseIdentity,
      MISE_AUTO_INSTALL: "true",
      MISE_TASK_RUN_AUTO_INSTALL: "true",
    };
    const args =
      operation === "checkpoint"
        ? ["run", "app:runtime", "prepare", input.appId, "preview", "--", "--checkpoint-only"]
        : ["run", "app:runtime", operation, input.appId, "preview"];
    const command = await input.provider.runCommand({
      args,
      cmd: "mise",
      cwd: input.root,
      env,
      signal: signal ?? input.signal,
    });
    if (command.exitCode !== 0) {
      throw new HostedRuntimeCommandError(operation, command.exitCode);
    }
    if (operation !== "verify") {
      return null;
    }
    // Only the repository's final JSON proof is interpreted; logs remain private.
    const stdout = await command.stdout({ signal: input.signal });
    const lines = stdout.trim().split("\n");
    const proof = z
      .object(hostedRuntimeProofSchema.shape)
      .parse(JSON.parse(lines.at(-1) ?? "null"));
    return {
      actors: proof.actors,
      artifactHash: proof.artifactHash,
      authenticatedBehavior: proof.authenticatedBehavior,
      releaseId: proof.releaseId,
      tenants: proof.tenants,
    };
  },
});
