import type { Sandbox } from "@vercel/sandbox";
import { readLocalOperatorArtifactAuthority } from "../provisioning/local-operator-artifact-store";
import { createLocalPrivateComputeJournal } from "./private-compute-journal";

/** Metadata only; this does not require or create a running VM. */
export const readPrivateComputeProviderState = async (
  native: Pick<Sandbox, "name" | "mounts" | "status" | "vcpus" | "memory">,
  assertCurrent: () => void | Promise<void>,
) => {
  await assertCurrent();
  const authority = await readLocalOperatorArtifactAuthority();
  if (authority === undefined) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Missing optional metadata is a deliberate unavailable result, never permission to execute.
    return undefined;
  }
  const mount = native.mounts?.["/workspace"];
  const journal = await createLocalPrivateComputeJournal({
    assertCurrent,
    authority,
    sandboxId: native.name,
    workspaceDrive: mount?.drive,
  });
  const checkpoint = await journal.read();
  if (
    checkpoint.record !== undefined &&
    (mount?.mode !== "read-write" || checkpoint.record.workspaceDrive !== mount.drive)
  ) {
    throw new Error(
      "The private compute journal belongs to another preserved workspace Drive; no resume was sent.",
    );
  }
  return {
    configuredMemoryMiB: native.memory,
    configuredVcpus: native.vcpus,
    phase: checkpoint.record?.phase ?? "not-requested",
    revision: checkpoint.revision,
    sandboxId: native.name,
    status: native.status,
  };
};
/** Only the separately approved activation port may resume an unresolved resource transition. */
export const assertPrivateComputeResumeAllowed = async (
  native: Parameters<typeof readPrivateComputeProviderState>[0],
  assertCurrent: () => void | Promise<void>,
) => {
  const observed = await readPrivateComputeProviderState(native, assertCurrent);
  if (observed !== undefined && observed.phase !== "not-requested" && observed.phase !== "ready") {
    throw new Error(
      "This workspace has a pending private compute operation. Read its provider state and continue its approved resource flow before starting another VM session; no resume was sent.",
    );
  }
};
