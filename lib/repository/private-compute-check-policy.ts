import { createHash } from "node:crypto";
import type { SandboxSession } from "eve/sandbox";
import { PRIVATE_COMPUTE_CHECK_TASK } from "../sandbox/private-compute-profile";
import type { PrivateComputeProfile } from "../sandbox/private-compute-profile";

/** A reviewed app-owned task mutation; preserve custom tasks and every lint/type-check family. */
export const applyPrivateComputeCheckPolicy = async (input: {
  sandbox: Pick<SandboxSession, "readTextFile" | "writeTextFile">;
  applyRoot: string;
  profile: PrivateComputeProfile;
}) => {
  const policy = input.profile.checkPolicy;
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  if (policy.afterSha256 !== hash(PRIVATE_COMPUTE_CHECK_TASK))
    throw new Error(
      "The reviewed compute check policy does not match its installed implementation.",
    );
  const file = `${input.applyRoot.replace(/^\/workspace\//u, "")}/${policy.path}`;
  const before = await input.sandbox.readTextFile({ path: file });
  if (before === PRIVATE_COMPUTE_CHECK_TASK) return;
  if (before === null || hash(before) !== policy.beforeSha256)
    throw new Error(
      "The app check task changed after planning. Preserve it and prepare a new reviewed change; no task was replaced.",
    );
  await input.sandbox.writeTextFile({ path: file, content: PRIVATE_COMPUTE_CHECK_TASK });
};
