import path from "node:path";

import { reconcileDeadEveEvalPrewarmLocks } from "../lib/testing/eve-eval-lifecycle";
import { createGateAEvalProfile } from "./gate-a-eval-profile.mjs";
import { runWithTestCapability } from "./run-with-test-capability.mts";
import {
  parseLinkedVercelProject,
  parseLocalVercelOidcToken,
  readOwnerBoundLocalFile,
  validateLocalVercelOidcToken,
} from "../lib/eve/local-vercel-oidc";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const eveEntry = path.resolve(repositoryRoot, "node_modules/eve/bin/eve.js");
const args = process.argv.slice(2);
const hostedOidcIndex = args.indexOf("--hosted-oidc");
const hostedOidc = hostedOidcIndex !== -1;
if (hostedOidc) args.splice(hostedOidcIndex, 1);
const liveModelIndex = args.indexOf("--live-model");
const liveModel = liveModelIndex !== -1;
if (liveModel) args.splice(liveModelIndex, 1);
const option = (name: string, required = false): string | undefined => {
  const index = args.indexOf(name);
  if (index === -1) {
    if (required) throw new Error(`Missing ${name}.`);
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
  args.splice(index, 2);
  if (args.includes(name)) throw new Error(`Duplicate ${name}.`);
  return value;
};
const profileName = option("--gate-a-profile", true);
const stateRoot = option("--gate-a-state-root");
const allowedRoot = option("--gate-a-allowed-root");
const fault = option("--gate-a-fault");
const image = option("--gate-a-image");
const sourceRoot = option("--gate-a-source-root");
let gateAEvalProfile;
if (profileName === "general-enabled" || profileName === "general-disabled") {
  gateAEvalProfile = createGateAEvalProfile(
    {
      localPublication: profileName === "general-enabled" ? "1" : "0",
      profile: "general",
    },
    repositoryRoot,
  );
} else if (profileName === "fresh") {
  gateAEvalProfile = createGateAEvalProfile(
    {
      allowedRoot,
      fault: fault ?? null,
      profile: "fresh",
      stateRoot,
    },
    repositoryRoot,
  );
} else if (profileName === "sandbox" || profileName === "hosted-artifact") {
  gateAEvalProfile = createGateAEvalProfile(
    {
      image: image ?? null,
      profile: profileName,
      sourceRoot: sourceRoot ?? null,
    },
    repositoryRoot,
  );
} else {
  throw new Error("The Gate A eval profile was invalid.");
}
if (gateAEvalProfile === undefined) throw new Error("The Gate A eval profile was invalid.");
if (
  gateAEvalProfile.profile !== "fresh" &&
  (stateRoot !== undefined || allowedRoot !== undefined || fault !== undefined)
)
  throw new Error("Fresh Gate A arguments require the fresh profile.");
if (
  gateAEvalProfile.profile !== "sandbox" &&
  gateAEvalProfile.profile !== "hosted-artifact" &&
  image !== undefined
)
  throw new Error("The sandbox image requires the sandbox profile.");
if (
  gateAEvalProfile.profile !== "sandbox" &&
  gateAEvalProfile.profile !== "hosted-artifact" &&
  sourceRoot !== undefined
)
  throw new Error("The sandbox source root requires the sandbox profile.");
const freshEvaluations = new Set([
  "fresh-bootstrap-publication",
  "fresh-bootstrap-empty-publication",
  "fresh-bootstrap-negative",
  "fresh-bootstrap-recovery",
  "fresh-bootstrap-wrong-source",
  "fresh-bootstrap-capabilities",
]);
if (
  gateAEvalProfile.profile === "fresh" &&
  (args[0] === undefined || !freshEvaluations.has(args[0]))
)
  throw new Error("The fresh Gate A evaluation was invalid.");
if (
  gateAEvalProfile.profile === "fresh" &&
  gateAEvalProfile.fault !== null &&
  args[0] !== "fresh-bootstrap-recovery"
)
  throw new Error("The fresh Gate A fault requires the recovery evaluation.");
const sandboxEvaluations = new Set([
  "sandbox-toolchain",
  "sandbox-identity-planning",
  "sandbox-reviewed-change-set",
  "sandbox-existing-iteration",
  "self-reproduction",
]);
if (
  (gateAEvalProfile.profile === "sandbox" || gateAEvalProfile.profile === "hosted-artifact") &&
  (args[0] === undefined || !sandboxEvaluations.has(args[0]))
)
  throw new Error("The sandbox Gate A evaluation was invalid.");
if (
  (gateAEvalProfile.profile === "sandbox" || gateAEvalProfile.profile === "hosted-artifact") &&
  args[0] === "sandbox-identity-planning" &&
  (gateAEvalProfile.image === null || gateAEvalProfile.sourceRoot === null)
)
  throw new Error("The sandbox identity/planning proof requires exact inputs.");
if (
  (gateAEvalProfile.profile === "sandbox" || gateAEvalProfile.profile === "hosted-artifact") &&
  args[0] === "sandbox-reviewed-change-set" &&
  (gateAEvalProfile.image === null || gateAEvalProfile.sourceRoot === null)
)
  throw new Error("The sandbox reviewed change-set proof requires exact inputs.");
if (args.some((argument) => argument.startsWith("--gate-a-")))
  throw new Error("An unknown Gate A argument remained.");
const realSandbox =
  gateAEvalProfile.profile === "sandbox" || gateAEvalProfile.profile === "hosted-artifact";
if (realSandbox) {
  const locks = await reconcileDeadEveEvalPrewarmLocks(repositoryRoot);
  for (const lock of locks) {
    if (lock.status === "active") continue;
    const owner = lock.pid === undefined ? "" : ` owned by PID ${lock.pid}`;
    if (lock.status === "removed")
      console.error(`eve eval: removed dead prewarm lock ${lock.lock}${owner}`);
    else console.error(`eve eval: preserved prewarm lock ${lock.lock}${owner}: ${lock.reason}`);
  }
}
if (liveModel && (gateAEvalProfile.profile !== "sandbox" || args[0] !== "self-reproduction"))
  throw new Error("The live model is restricted to the self-reproduction sandbox evaluation.");
if (hostedOidc && !liveModel)
  throw new Error("Hosted identity is only supported for the live self-reproduction eval.");
if (liveModel && hostedOidc) {
  const { syncHostedEvalIdentity } = await import("../lib/evals/hosted-eval-identity-refresh");
  await syncHostedEvalIdentity();
} else if (liveModel) {
  const project = parseLinkedVercelProject(
    readOwnerBoundLocalFile(path.resolve(repositoryRoot, ".vercel/project.json"), {
      confidential: false,
    }),
  );
  const token = parseLocalVercelOidcToken(
    readOwnerBoundLocalFile(path.resolve(repositoryRoot, ".env.local"), { confidential: true }),
  );
  process.env.VERCEL_OIDC_TOKEN = validateLocalVercelOidcToken({
    nowEpochSeconds: Math.floor(Date.now() / 1000),
    project,
    token,
  });
  process.env.VERCEL_TEAM_ID = project.orgId;
  process.env.VERCEL_PROJECT_ID = project.projectId;
}
let capabilities: string[];
if (liveModel) {
  capabilities = [];
} else if (realSandbox) {
  capabilities = ["mock-model"];
} else {
  capabilities = ["mock-model", "simulated-target", "simulated-publication"];
}

const exitCode = await runWithTestCapability({
  args: [eveEntry, "eval", ...args],
  capabilities,
  command: process.execPath,
  gateAEvalProfile,
  profile: "eve",
});
process.exitCode = exitCode;
