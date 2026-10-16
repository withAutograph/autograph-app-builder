import { createHash } from "node:crypto";

import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";

import { assertAppBaselineAuthority, readAppBaselineMarker } from "./app-baseline";
import type { AppBaselineReceipt, AppBaselineSelection } from "./app-baseline";
import { planningOverlayRoot } from "./dependency-cache";
import { ensureSandboxDirectories } from "./sandbox-filesystem";
import { assertCurrentTargetApplyReceipt } from "./target-apply";
import type { TargetApplyReceipt } from "./target-apply";

const hash = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const quote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;
const preserved = { status: "preserved" } as const;
const resultSchema = z.strictObject({
  status: z.enum(["restored", "already-restored", "preserved"]),
});

/** Only the exact retained Builder postimage may be replaced with its proven source preimage. */
const recoveryProgram = String.raw`
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { lstatSync, readFileSync, writeFileSync, unlinkSync, chmodSync } = require("node:fs");
const { join } = require("node:path");
const input = JSON.parse(process.argv[1]);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const result = status => console.log(JSON.stringify({ status }));
const safe = relative => {
  let current = input.root;
  for (const part of relative.split("/")) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) return false; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return true;
};
if (!safe(input.path)) { result("preserved"); process.exit(0); }
const git = args => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", input.root, ...args], { stdio: ["ignore", "pipe", "pipe"] });
let preimage;
try {
  const record = git(["ls-tree", "-z", input.commit, "--", input.path]).toString("utf8");
  if (record === "") {
    if (input.expected !== null) { result("preserved"); process.exit(0); }
    preimage = null;
  } else {
    const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t([^\0]+)\0$/.exec(record);
    if (!match || match[3] !== input.path || input.expected === null) { result("preserved"); process.exit(0); }
    const bytes = git(["cat-file", "blob", match[2]]);
    const mode = match[1].slice(3);
    if (digest(bytes) !== input.expected.digest || mode !== input.expected.mode) { result("preserved"); process.exit(0); }
    preimage = { bytes, mode };
  }
} catch { result("preserved"); process.exit(0); }
const destination = join(input.root, input.path);
let current;
try {
  const stat = lstatSync(destination);
  if (!stat.isFile()) { result("preserved"); process.exit(0); }
  current = { bytes: readFileSync(destination), mode: (stat.mode & 0o111) ? "755" : "644" };
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  current = null;
}
if (preimage === null ? current === null : current !== null && digest(current.bytes) === digest(preimage.bytes) && current.mode === preimage.mode) {
  result("already-restored"); process.exit(0);
}
if (current === null || digest(current.bytes) !== input.writerDigest || current.mode !== input.writerMode) { result("preserved"); process.exit(0); }
if (preimage === null) unlinkSync(destination);
else { writeFileSync(destination, preimage.bytes); chmodSync(destination, Number.parseInt(preimage.mode, 8)); }
result("restored");
`;

export interface LegacyAppSpecRecoveryInput {
  sandbox: SandboxSession;
  sessionId: string;
  repository: { repositoryId: string; owner: string; name: string };
  appId: string;
  artifactRevision: string;
  appSpecDigest: string;
  apply: TargetApplyReceipt;
  baseline?: { selection: AppBaselineSelection; receipt?: AppBaselineReceipt };
  /** Reopens the exact accepted artifact under the current session authority. */
  readAcceptedContent: () => Promise<string>;
  workspaceRoot?: string;
}

const legacyWriterPostimage = (input: LegacyAppSpecRecoveryInput, path: string) => {
  const postimage = input.apply.postTree.find((file) => file.path === path);
  const bindingsMatch = [
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(input.appId),
    input.apply.appSpecDigest === input.appSpecDigest,
    input.apply.artifactRevision === input.artifactRevision,
    input.apply.command.exitCode === 0,
    input.apply.appliedByCallId.length > 0,
  ].every(Boolean);
  if (
    !bindingsMatch ||
    postimage === undefined ||
    postimage.digest !== input.appSpecDigest ||
    !["644", "755", "100644", "100755"].includes(postimage.mode)
  ) {
    return null;
  }
  return postimage;
};

export const recoverLegacyAppSpecTransport = async (input: LegacyAppSpecRecoveryInput) => {
  const path = `.config/app-specs/${input.appId}.md`;
  const postimage = legacyWriterPostimage(input, path);
  if (postimage === null) {
    return preserved;
  }
  assertCurrentTargetApplyReceipt(input.apply);
  const { digest, ...unsigned } = input.apply;
  if (hash(JSON.stringify(unsigned)) !== digest) {
    return preserved;
  }
  const accepted = await input.readAcceptedContent();
  if (hash(accepted) !== input.appSpecDigest) {
    return preserved;
  }
  const externalPath = `${planningOverlayRoot(input.artifactRevision)}/${path}`;
  const external = await input.sandbox.readBinaryFile({ path: externalPath });
  if (external !== null && hash(external) !== input.appSpecDigest) {
    return preserved;
  }
  await ensureSandboxDirectories(input.sandbox, [
    externalPath.slice(0, externalPath.lastIndexOf("/")),
  ]);
  await input.sandbox.writeBinaryFile({ path: externalPath, content: Buffer.from(accepted) });
  const { baseline } = input;
  if (
    baseline?.receipt === undefined ||
    baseline.selection.appId !== input.appId ||
    baseline.receipt.platform.commitSha !== input.apply.sourceSha
  ) {
    return preserved;
  }
  assertAppBaselineAuthority({
    selection: baseline.selection,
    repository: input.repository,
    sessionId: input.sessionId,
  });
  const marker = await readAppBaselineMarker(input.sandbox, baseline.selection);
  if (marker === undefined || marker.receipt.digest !== baseline.receipt.digest) {
    return preserved;
  }
  const expected = marker.platformFiles.find((file) => file.path === path) ?? null;
  const request = {
    root: `${input.workspaceRoot ?? "/workspace"}/repository`,
    path,
    commit: marker.receipt.platform.commitSha,
    expected,
    writerDigest: input.appSpecDigest,
    writerMode: postimage.mode === "100755" || postimage.mode === "755" ? "755" : "644",
  };
  const result = await input.sandbox.run({
    command: `node -e ${quote(recoveryProgram)} ${quote(JSON.stringify(request))}`,
    workingDirectory: input.workspaceRoot ?? "/workspace",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Builder could not restore its legacy AppSpec transport (exit ${result.exitCode}). The original app and candidate remain unchanged.`,
    );
  }
  return resultSchema.parse(JSON.parse(result.stdout));
};
