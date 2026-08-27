import { resolve } from "node:path";

import { createGateAEvalProfile } from "./gate-a-eval-profile.mjs";
import { runWithTestCapability } from "./run-with-test-capability.mts";

const repositoryRoot = resolve(import.meta.dirname, "..");
const eveEntry = resolve(repositoryRoot, "node_modules/eve/bin/eve.js");
const args = process.argv.slice(2);
const option = (name: string, required = false): string | undefined => {
  const index = args.indexOf(name);
  if (index < 0) {
    if (required) throw new Error(`Missing ${name}.`);
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--"))
    throw new Error(`Missing value for ${name}.`);
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
const gateAEvalProfile =
  profileName === "general-enabled" || profileName === "general-disabled"
    ? createGateAEvalProfile(
        {
          profile: "general",
          localPublication: profileName === "general-enabled" ? "1" : "0",
        },
        repositoryRoot,
      )
    : profileName === "fresh"
      ? createGateAEvalProfile(
          {
            profile: "fresh",
            stateRoot,
            allowedRoot,
            fault: fault ?? null,
          },
          repositoryRoot,
        )
      : profileName === "sandbox" || profileName === "hosted-artifact"
        ? createGateAEvalProfile(
            {
              profile: profileName,
              image: image ?? null,
              sourceRoot: sourceRoot ?? null,
            },
            repositoryRoot,
          )
        : (() => {
            throw new Error("The Gate A eval profile was invalid.");
          })();
if (gateAEvalProfile === undefined)
  throw new Error("The Gate A eval profile was invalid.");
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
]);
if (
  (gateAEvalProfile.profile === "sandbox" ||
    gateAEvalProfile.profile === "hosted-artifact") &&
  (args[0] === undefined || !sandboxEvaluations.has(args[0]))
)
  throw new Error("The sandbox Gate A evaluation was invalid.");
if (
  (gateAEvalProfile.profile === "sandbox" ||
    gateAEvalProfile.profile === "hosted-artifact") &&
  args[0] === "sandbox-identity-planning" &&
  (gateAEvalProfile.image === null || gateAEvalProfile.sourceRoot === null)
)
  throw new Error("The sandbox identity/planning proof requires exact inputs.");
if (args.some((argument) => argument.startsWith("--gate-a-")))
  throw new Error("An unknown Gate A argument remained.");
const realSandbox =
  gateAEvalProfile.profile === "sandbox" ||
  gateAEvalProfile.profile === "hosted-artifact";
const capabilities = realSandbox
  ? ["mock-model"]
  : ["mock-model", "simulated-target", "simulated-publication"];

const exitCode = await runWithTestCapability({
  profile: "eve",
  command: process.execPath,
  args: [eveEntry, "eval", ...args],
  capabilities,
  gateAEvalProfile,
});
process.exitCode = exitCode;
