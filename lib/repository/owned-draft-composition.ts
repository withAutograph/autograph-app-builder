import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { SandboxSession } from "eve/sandbox";
import type { OwnedPublicationReconciliationScope } from "./github-draft-reconciliation";
import { assertOwnedPublicationReconciliationOrigin } from "./github-draft-reconciliation";
import { safeSourcePath } from "./source-path";
import { planApplicationSourceRegistration } from "./application-source-registration";
import { planOwnedAppRootManifest } from "./owned-app-root-manifest";
import { sanitizeValidationDiagnosticText } from "./validation-output-sanitize";

export interface OriginalPublicationRepair {
  discardAddedPaths: readonly string[];
}
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
const compositionPaths = ["package.json", "microfrontends.json", "bun.lock"];
const planSchema = z.strictObject({
  restorePaths: z.array(z.string()),
  originalPackage: z.string(),
});

// Read only immutable Git entries before touching a new candidate. Public input
// selects original additions, never replacement bytes or an arbitrary Git ref.
const planProgram = String.raw`
const {execFileSync}=require("node:child_process");
const [root,json]=process.argv.slice(1);
const p=JSON.parse(json);
const git=args=>execFileSync("git",["--literal-pathspecs","-c","core.hooksPath=/dev/null","-C",root,...args],{encoding:"utf8"});
const entry=(sha,path)=>git(["ls-tree","-z",sha,"--",path]).split("\0").filter(Boolean).map(row=>{const m=/^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(row);if(!m||m[2]!=="blob"||m[4]!==path||!['100644','100755'].includes(m[1]))throw Error("Unsupported original publication entry: "+path);return {mode:m[1],blob:m[3]};})[0]??null;
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
if(git(["rev-parse",p.originalHead+"^{tree}"]).trim()!==p.originalTree||git(["rev-parse",p.originalBase+"^{tree}"]).trim()!==p.originalBaseTree)throw Error("Original publication Git trees do not match the owned receipt");
const changed=git(["diff","--no-renames","--name-only","-z",p.originalBase,p.originalHead]).split("\0").filter(Boolean).sort();
if(!same(changed,[...p.approvedPaths].sort()))throw Error("Original publication paths do not match the owned receipt");
const restore=new Set();
for(const path of p.discardAddedPaths){
 if(!p.approvedPaths.includes(path)||entry(p.originalBase,path)!==null)throw Error("Selected cleanup path was not added by this publication: "+path);
 const original=entry(p.originalHead,path);
 if(original===null||!same(original,entry(p.currentHead,path)))throw Error("Selected cleanup path has newer or unknown draft changes: "+path);
 if(entry(p.currentBase,path)!==null)throw Error("Selected cleanup path is now owned by the current target base: "+path);
 restore.add(path);
}
for(const path of p.compositionPaths){
 const original=entry(p.originalHead,path);
 const before=entry(p.originalBase,path);
 if(!same(original,before)){
  if(!same(original,entry(p.currentHead,path)))throw Error("Composition has newer or unknown draft changes: "+path);
  restore.add(path);
 }else if(!same(before,entry(p.currentHead,path))){
  throw Error("Composition has unowned draft changes: "+path);
 }
}
console.log(JSON.stringify({restorePaths:[...restore].sort(),originalPackage:git(["show",p.originalHead+":package.json"])}));
`;
const checked = async (sandbox: SandboxSession, operation: string, command: string) => {
  const result = await sandbox.run({ command, workingDirectory: "/workspace" });
  if (result.exitCode !== 0) {
    // The fixed programs report only path/provenance failures, never credentials.
    throw new Error(
      `Builder could not ${operation}. ${sanitizeValidationDiagnosticText(result.stderr || "The repository command failed.")}`,
    );
  }
  return result.stdout;
};
const git = (root: string, args: readonly string[]) =>
  `git --literal-pathspecs -c core.hooksPath=/dev/null -c commit.gpgsign=false -C ${quote(root)} ${args.map(quote).join(" ")}`;

export const planOriginalPublicationRepair = async (input: {
  sandbox: SandboxSession;
  checkout: string;
  appId: string;
  headSha: string;
  baseSha: string;
  owned: Pick<OwnedPublicationReconciliationScope, "proposal" | "publication">;
  repair: OriginalPublicationRepair;
}) => {
  assertOwnedPublicationReconciliationOrigin(input.owned);
  const paths = input.repair.discardAddedPaths;
  if (
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(input.appId) ||
    new Set(paths).size !== paths.length ||
    paths.some(
      (path) =>
        !safeSourcePath(path) || path.startsWith("apps/") || compositionPaths.includes(path),
    )
  ) {
    throw new Error(
      "Original publication cleanup must select distinct outside-app additions; composition is rebuilt separately.",
    );
  }
  const { proposal, publication } = input.owned;
  if (!proposal.approvedPaths.some((path) => path.startsWith(`apps/${input.appId}/`))) {
    throw new Error("The original publication does not contain this selected app.");
  }
  const request = {
    originalBase: proposal.baseSha,
    originalBaseTree: proposal.baseTree,
    originalHead: publication.branchSha,
    originalTree: publication.branchTree,
    currentHead: input.headSha,
    currentBase: input.baseSha,
    approvedPaths: proposal.approvedPaths,
    discardAddedPaths: paths,
    compositionPaths,
  };
  return planSchema.parse(
    JSON.parse(
      await checked(
        input.sandbox,
        "verify original publication cleanup",
        `node -e ${quote(planProgram)} ${quote(input.checkout)} ${quote(JSON.stringify(request))}`,
      ),
    ),
  );
};

export const stageOriginalPublicationRepair = async (input: {
  sandbox: SandboxSession;
  root: string;
  originalBase: string;
  plan: z.infer<typeof planSchema>;
}) => {
  if (input.plan.restorePaths.length === 0) {
    return;
  }
  await checked(
    input.sandbox,
    "restore only the proven original publication delta",
    git(input.root, [
      "restore",
      `--source=${input.originalBase}`,
      "--staged",
      "--worktree",
      "--",
      ...input.plan.restorePaths,
    ]),
  );
  const changed = await checked(
    input.sandbox,
    "inspect the private original-publication correction",
    git(input.root, ["diff", "--cached", "--name-only"]),
  );
  if (changed.trim() !== "") {
    await checked(
      input.sandbox,
      "record the private original-publication correction",
      git(input.root, [
        "-c",
        "user.name=Autograph App Builder",
        "-c",
        "user.email=builder@autograph.so",
        "commit",
        "--no-verify",
        "--no-gpg-sign",
        "-m",
        "Rebuild original app composition from its target base",
      ]),
    );
  }
};

const readAppManifestProgram = String.raw`
const fs=require("node:fs");const path=require("node:path");
const [root,relative]=process.argv.slice(1);let target=fs.realpathSync(root);
for(const part of relative.split("/")){target=path.join(target,part);if(fs.lstatSync(target).isSymbolicLink())throw Error("Symlink in selected app manifest path");}
if(!fs.lstatSync(target).isFile())throw Error("Selected app manifest is not a regular file");
process.stdout.write(fs.readFileSync(target));
`;

export const rebuildOriginalPublicationComposition = async (input: {
  sandbox: SandboxSession;
  root: string;
  workspaceRoot: string;
  appId: string;
  baseSha: string;
  originalPackage: string;
}) => {
  const read = (revision: string, path: string) =>
    checked(
      input.sandbox,
      `read owned app composition ${path}`,
      git(input.root, ["show", `${revision}:${path}`]),
    );
  const manifestPath = `apps/${input.appId}/package.json`;
  const [basePackage, baseRoutes, appManifest] = await Promise.all([
    read(input.baseSha, "package.json"),
    read(input.baseSha, "microfrontends.json"),
    checked(
      input.sandbox,
      "read the selected app manifest",
      `node -e ${quote(readAppManifestProgram)} ${quote(input.root)} ${quote(manifestPath)}`,
    ),
  ]);
  const rootManifest = planOwnedAppRootManifest({
    appId: input.appId,
    base: basePackage,
    originalPublished: input.originalPackage,
    appManifest,
  });
  const registration = await planApplicationSourceRegistration(
    input.sandbox,
    input.appId,
    baseRoutes,
  );
  // Existing entries must stay identical; the platform planner owns only this app's addition.
  const routes = z.object({ applications: z.record(z.string(), z.unknown()) });
  const before = routes.parse(JSON.parse(baseRoutes)).applications;
  const after = routes.parse(JSON.parse(registration.proposedBytes)).applications;
  if (Object.entries(before).some(([key, value]) => !isDeepStrictEqual(value, after[key]))) {
    throw new Error("The registration planner changed an existing application.");
  }
  const relative = input.root.slice(input.workspaceRoot.length + 1);
  await input.sandbox.writeTextFile({ path: `${relative}/package.json`, content: rootManifest });
  await input.sandbox.writeTextFile({
    path: `${relative}/microfrontends.json`,
    content: registration.proposedBytes,
  });
  // Seed from the current target lock so unrelated workspaces retain their selections.
  await checked(
    input.sandbox,
    "restore the current target dependency lock",
    git(input.root, [
      "restore",
      `--source=${input.baseSha}`,
      "--staged",
      "--worktree",
      "--",
      "bun.lock",
    ]),
  );
  const trust = 'MISE_TRUSTED_CONFIG_PATHS="$MISE_TRUSTED_CONFIG_PATHS:"';
  await checked(
    input.sandbox,
    "regenerate owned app composition lock metadata",
    `cd ${quote(input.root)} && ${trust}${quote(input.root)} mise exec --no-deps -- bun install --lockfile-only --ignore-scripts`,
  );
  await checked(
    input.sandbox,
    "stage the platform-produced app composition",
    git(input.root, ["add", "--", ...compositionPaths]),
  );
};
