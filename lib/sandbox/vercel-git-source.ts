import { createHash } from "node:crypto";
import type { Command } from "@vercel/sandbox";
import { holdActiveCommandLease } from "./active-command-lease";
import type { VercelSdkSessionNative } from "./vercel-sdk-session";
import type { VercelGitSessionSource } from "./vercel-session-source";

const target = "/workspace/repository";
const gitEnvironment = {
  GIT_ASKPASS: "/usr/bin/false",
  GIT_CONFIG_COUNT: "0",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_PARAMETERS: "",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CURL_VERBOSE: "0",
  GIT_LFS_SKIP_SMUDGE: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_TRACE: "0",
  GIT_TRACE2: "0",
  GIT_TRACE2_EVENT: "0",
  GIT_TRACE2_PERF: "0",
  GIT_TRACE_CURL: "0",
  GIT_TRACE_PACKET: "0",
  GIT_TRACE_SETUP: "0",
  SSH_ASKPASS: "/usr/bin/false",
};
const gitOptions = [
  "-c",
  "credential.helper=",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "http.followRedirects=false",
];
const occupiedProgram = `const fs=require("node:fs");
try { fs.lstatSync(process.argv[1]); process.exit(0); }
catch(error) { if(error.code === "ENOENT") process.exit(1); process.exit(2); }`;

/** Source acquisition is server-owned SDK I/O, outside model-visible shell logs. */
export const materializeVercelGitSource = async (input: {
  current: () => VercelSdkSessionNative;
  authorize?: () => Promise<void>;
  source: VercelGitSessionSource;
}): Promise<void> => {
  const { source } = input;
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/u.test(source.url)) {
    throw new Error("The selected GitHub source URL is invalid.");
  }
  if (source.revision !== undefined && source.revision.startsWith("-")) {
    throw new Error("The selected GitHub source revision is invalid.");
  }
  await input.authorize?.();
  const lease = await holdActiveCommandLease(input);
  const staging = `/workspace/.app-builder/source-acquisition/${createHash("sha256")
    .update(JSON.stringify([source.url, source.revision ?? null]))
    .digest("hex")}/repository`;
  const run = async (cmd: string, args: string[], env: Record<string, string> = gitEnvironment) => {
    await input.authorize?.();
    lease.signal.throwIfAborted();
    let command: Command | undefined;
    let killing: Promise<void> | undefined;
    const kill = () => {
      if (command !== undefined && killing === undefined) {
        const ownedCommand = command;
        killing = (async () => {
          try {
            await ownedCommand.kill("SIGTERM");
          } catch {
            // Cancellation can race normal command completion.
          }
        })();
      }
    };
    lease.signal.addEventListener("abort", kill, { once: true });
    try {
      command = await input.current().runCommand({
        args,
        cmd,
        cwd: "/workspace",
        detached: true,
        env,
        signal: lease.signal,
      });
      if (lease.signal.aborted) {
        kill();
      }
      const result = await command.wait({ signal: lease.signal });
      lease.signal.throwIfAborted();
      return { exitCode: result.exitCode, stdout: await command.stdout({ signal: lease.signal }) };
    } catch {
      kill();
      // SDK errors may carry response bodies; never propagate them or a cause.
      throw new Error(
        "Vercel could not complete GitHub source acquisition. Retry this same Builder session.",
      );
    } finally {
      lease.signal.removeEventListener("abort", kill);
      await killing;
    }
  };
  const git = async (args: string[], env?: Record<string, string>) =>
    await run("git", [...gitOptions, ...args], env);
  try {
    const occupied = await run("node", ["-e", occupiedProgram, target]);
    if (occupied.exitCode !== 1) {
      throw new Error("Builder will not replace the occupied repository workspace.");
    }
    await input.current().fs.mkdir(staging.slice(0, staging.lastIndexOf("/")), { recursive: true });
    const staged = await run("node", ["-e", occupiedProgram, staging]);
    if (staged.exitCode === 1) {
      // Git's per-command config environment is absent from SDK command metadata.
      // No URL, argv, written file, Git config, or model command contains the token.
      const cloneRevision =
        source.revision === undefined || /^[0-9a-f]{40}$/iu.test(source.revision)
          ? []
          : ["--branch", source.revision];
      const authorization = Buffer.from(`x-access-token:${source.token}`).toString("base64");
      const cloned = await git(["clone", "--quiet", ...cloneRevision, "--", source.url, staging], {
        ...gitEnvironment,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `http.${source.url}.extraheader`,
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${authorization}`,
      });
      if (cloned.exitCode !== 0) {
        throw new Error(
          "GitHub source acquisition failed. Check repository access, then retry this same Builder session.",
        );
      }
    } else if (staged.exitCode !== 0) {
      throw new Error("Vercel could not inspect the source acquisition directory.");
    }
    // Reuse a completed staging checkout after an uncertain placement response.
    // An incomplete acquisition is reported rather than removing its directory.
    const remote = await git(["-C", staging, "remote", "get-url", "origin"]);
    const head = await git(["-C", staging, "rev-parse", "--verify", "HEAD"]);
    if (remote.exitCode !== 0 || remote.stdout.trim() !== source.url || head.exitCode !== 0) {
      throw new Error(
        "The staged GitHub source acquisition is incomplete. Retry this same Builder session after the provider command completes.",
      );
    }
    if (source.revision !== undefined) {
      const checked = await git([
        "-C",
        staging,
        "checkout",
        "--quiet",
        "--detach",
        source.revision,
      ]);
      if (checked.exitCode !== 0) {
        throw new Error(
          "GitHub could not check out the selected source revision. Check the revision, then retry this same Builder session.",
        );
      }
    }
    // GNU mv on the managed Linux image refuses an occupied destination,
    // including one created after inspection. It never merges directories.
    const placed = await run("mv", [
      "--no-clobber",
      "--no-target-directory",
      "--",
      staging,
      target,
    ]);
    const remaining = await run("node", ["-e", occupiedProgram, staging]);
    if (placed.exitCode !== 0 || remaining.exitCode !== 1) {
      throw new Error(
        "Builder could not place the acquired GitHub source in its workspace. Retry this same Builder session; its existing files have been preserved.",
      );
    }
  } finally {
    await lease.finish();
  }
};
