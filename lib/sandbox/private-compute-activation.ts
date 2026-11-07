import { createHash } from "node:crypto";
import { Sandbox, APIError } from "@vercel/sandbox";
import { createLocalPrivateComputeJournal } from "./private-compute-journal";
import { readLocalOperatorArtifactAuthority } from "../provisioning/local-operator-artifact-store";
import { peekVercelPreviewProvider, replaceVercelPreviewProvider } from "./vercel-preview-provider";
import {
  PRIVATE_COMPUTE_CHECK_TASK,
  privateComputeProfileSchema,
  readPrivateComputeLimits,
} from "./private-compute-profile";
import type { PrivateComputeActivation, PrivateComputeProfile } from "./private-compute-profile";
import { assertHostedSandboxCommandAuthority } from "./deployment-execution-lease";

export type { PrivateComputeActivation } from "./private-compute-profile";

export type PrivateComputeNative = Pick<
  Sandbox,
  "name" | "persistent" | "mounts" | "status" | "vcpus" | "memory" | "update"
> & {
  currentSession: () => Pick<ReturnType<Sandbox["currentSession"]>, "vcpus" | "memory">;
  stop: () => Promise<undefined | Awaited<ReturnType<Sandbox["stop"]>>>;
};
interface ActivationPorts<T extends PrivateComputeNative> {
  read: () => Promise<T>;
  resume: () => Promise<T>;
  readActivation: () => Promise<PrivateComputeActivation | undefined>;
  writeActivation: (record: PrivateComputeActivation) => Promise<void>;
  assertCurrent: () => void | Promise<void>;
}
const assertTarget = (native: PrivateComputeNative, profile: PrivateComputeProfile) => {
  const mount = native.mounts?.["/workspace"];
  if (
    native.name !== profile.target.sandboxId ||
    !native.persistent ||
    mount?.mode !== "read-write" ||
    mount.drive !== profile.target.workspaceDrive
  ) {
    throw new Error(
      "The compute profile no longer belongs to this exact persistent Sandbox and workspace Drive.",
    );
  }
};
const configured = (native: PrivateComputeNative, profile: PrivateComputeProfile) =>
  native.vcpus === profile.vcpus && native.memory === profile.memoryMiB;
const running = (native: PrivateComputeNative, profile: PrivateComputeProfile) =>
  native.status === "running" &&
  native.currentSession().vcpus === profile.vcpus &&
  native.currentSession().memory === profile.memoryMiB;

/** Every intent acknowledgement is awaited before the corresponding SDK mutation. */
export const activatePrivateComputeProfile = async <T extends PrivateComputeNative>(
  input: {
    profile: PrivateComputeProfile;
    proposalDigest: string;
    callId: string;
    appId: string;
    sessionId: string;
  },
  ports: ActivationPorts<T>,
) => {
  const profile = privateComputeProfileSchema.parse(input.profile);
  await ports.assertCurrent();
  let native = await ports.read();
  await ports.assertCurrent();
  assertTarget(native, profile);
  if (native.status !== "running" && native.status !== "stopped") {
    throw new Error(
      "The provider execution session is still transitioning or unavailable; no resource operation was sent.",
    );
  }
  let previous = await ports.readActivation();
  const write = async (phase: PrivateComputeActivation["phase"]) => {
    await ports.assertCurrent();
    const activation: PrivateComputeActivation = {
      appId: input.appId,
      phase,
      profileId: profile.id,
      proposalDigest: input.proposalDigest,
      sandboxId: profile.target.sandboxId,
      sessionId: input.sessionId,
      workspaceDrive: profile.target.workspaceDrive,
    };
    if (phase === "ready") {
      activation.completedByCallId = input.callId;
    }
    await ports.writeActivation(activation);
    previous = await ports.readActivation();
  };
  if (configured(native, profile) && running(native, profile)) {
    await write("ready");
    return native;
  }
  const pendingUpdate = previous?.phase === "configuring" && !configured(native, profile);
  const pendingStop = previous?.phase === "stopping" && native.status === "running";
  if (previous?.phase === "resuming" || pendingUpdate || pendingStop) {
    throw new Error(
      "The prior private compute operation has an uncertain provider outcome. Its request remains preserved; read provider state before any further resource operation.",
    );
  }
  if (native.status === "running") {
    await write("stopping");
    await ports.assertCurrent();
    await native.stop();
    await ports.assertCurrent();
    native = await ports.read();
    assertTarget(native, profile);
    if (native.status !== "stopped") {
      throw new Error(
        "The provider has not confirmed that the original execution session stopped; no resource update was sent.",
      );
    }
  }
  if (!configured(native, profile)) {
    await write("configuring");
    await ports.assertCurrent();
    await native.update({ resources: { vcpus: profile.vcpus } });
    await ports.assertCurrent();
    native = await ports.read();
    assertTarget(native, profile);
    if (!configured(native, profile)) {
      throw new Error(
        "The provider has not confirmed the selected compute configuration; no resume was sent.",
      );
    }
  }
  await write("resuming");
  await ports.assertCurrent();
  native = await ports.resume();
  assertTarget(native, profile);
  if (!configured(native, profile) || !running(native, profile)) {
    throw new Error(
      "The resumed provider session has not confirmed the approved compute resources.",
    );
  }
  await write("ready");
  return native;
};

const boundedProviderFailure = (error: { response: Response }) => {
  const reference = error.response.headers.get("x-vercel-id");
  const safeReference =
    reference !== null && /^[A-Za-z0-9:._-]{1,120}$/u.test(reference)
      ? ` reference ${reference}`
      : "";
  return new Error(
    `The private compute provider operation failed (HTTP ${error.response.status}${safeReference}). Its pending request is preserved for independent readback; no automatic resend was made.`,
  );
};

/** Called only after genuine private apply approval; no model input can invoke raw resources. */
export const applyApprovedPrivateComputeProfile = async (input: {
  profile: PrivateComputeProfile;
  proposalDigest: string;
  callId: string;
  sessionId: string;
  appId: string;
  assertCurrent: () => void;
}) => {
  if (
    input.profile.checkPolicy.afterSha256 !==
    createHash("sha256").update(PRIVATE_COMPUTE_CHECK_TASK).digest("hex")
  ) {
    throw new Error(
      "The frozen compute policy does not match the installed check operation; no resource request was sent.",
    );
  }
  const limits = readPrivateComputeLimits();
  if (
    limits.projectId !== input.profile.limits.projectId ||
    limits.teamId !== input.profile.limits.teamId ||
    limits.maxVcpus < input.profile.vcpus
  ) {
    throw new Error("Current observed provider limits do not match the reviewed compute target.");
  }
  const assertCurrent = async () => {
    input.assertCurrent();
    await assertHostedSandboxCommandAuthority({ sessionId: input.sessionId });
  };
  const authority = await readLocalOperatorArtifactAuthority();
  if (authority === undefined) {
    throw new Error(
      "This compute profile needs the supported private local resource journal; no provider operation was sent.",
    );
  }
  const journal = await createLocalPrivateComputeJournal({
    assertCurrent,
    authority,
    sandboxId: input.profile.target.sandboxId,
    workspaceDrive: input.profile.target.workspaceDrive,
  });
  let checkpoint = await journal.read();
  const original = peekVercelPreviewProvider(input.profile.target.sandboxId);
  let replacement: Sandbox;
  try {
    replacement = await activatePrivateComputeProfile(input, {
      assertCurrent,
      read: async () => await Sandbox.get({ name: input.profile.target.sandboxId, resume: false }),
      readActivation: async () => {
        checkpoint = await journal.read();
        return checkpoint.record;
      },
      resume: async () => await Sandbox.get({ name: input.profile.target.sandboxId, resume: true }),
      writeActivation: async (record) => {
        checkpoint = await journal.append(record, checkpoint);
      },
    });
  } catch (error) {
    if (error instanceof APIError) {
      throw boundedProviderFailure(error);
    }
    throw error;
  }
  if (original !== undefined) {
    replaceVercelPreviewProvider(input.profile.target.sandboxId, original, replacement);
  }
  return {
    memoryMiB: replacement.currentSession().memory,
    profileId: input.profile.id,
    sandboxId: replacement.name,
    vcpus: replacement.currentSession().vcpus,
    workspaceDrive: input.profile.target.workspaceDrive,
  };
};
/** Undefined retains the historical default and causes no provider read or effect. */
export const applyPrivateComputeWhenSelected = async (
  input: Omit<Parameters<typeof applyApprovedPrivateComputeProfile>[0], "profile"> & {
    profile: PrivateComputeProfile | undefined;
  },
) => {
  if (input.profile !== undefined) {
    return await applyApprovedPrivateComputeProfile({ ...input, profile: input.profile });
  }
  // oxlint-disable-next-line unicorn/no-useless-undefined -- An unselected profile explicitly performs no operation and returns no provider state.
  return undefined;
};
export const assertPrivateComputeInput = (
  requested: PrivateComputeProfile["id"] | undefined,
  planned: PrivateComputeProfile | undefined,
  workspaceId: string,
  appId: string,
): void => {
  if (requested !== planned?.id) {
    throw new Error(
      "Use the exact private compute profile from the current plan so its footprint is shown on the normal Build approval. No provider request was sent.",
    );
  }
  if (
    planned !== undefined &&
    (planned.target.sandboxId !== workspaceId ||
      planned.checkPolicy.path !== `apps/${appId}/.config/mise/tasks/check`)
  ) {
    throw new Error(
      "The compute profile belongs to another app or private workspace. No provider request was sent.",
    );
  }
};
