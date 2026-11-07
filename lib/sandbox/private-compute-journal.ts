/* oxlint-disable eslint/require-await, sonarjs/expression-complexity -- The promise-shaped journal factory rejects invalid ownership asynchronously and checks the complete immutable causal prefix in order. */
import { createHash } from "node:crypto";
import path from "node:path";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";
import { localOperatorPrivateIo } from "../provisioning/local-operator-artifact-store";
import type { LocalOperatorArtifactAuthority } from "../provisioning/hosted-operator-artifact-store";
import { privateComputeActivationSchema } from "./private-compute-profile";
import type { PrivateComputeActivation } from "./private-compute-profile";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const entrySchema = z.strictObject({
  previous: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  record: privateComputeActivationSchema,
  revision: z.number().int().nonnegative(),
});
const syncDirectory = async (directory: string) => {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};
/** Same verified private filesystem backend as local operator artifacts; no model-supplied root or hosted principal. */
export const createLocalPrivateComputeJournal = async (input: {
  authority: LocalOperatorArtifactAuthority;
  sandboxId: string;
  workspaceDrive?: string;
  assertCurrent: () => void | Promise<void>;
}) => {
  if (input.authority.ownerUid !== process.getuid?.()) {
    throw new Error("The private compute journal belongs to another local owner.");
  }
  const root = path.join(input.authority.stateRoot, "private-compute-resources");
  const directory = path.join(root, hash(input.sandboxId));
  const ensure = async () => {
    await input.assertCurrent();
    await localOperatorPrivateIo.assertDirectory(input.authority.stateRoot);
    await localOperatorPrivateIo.ensureDirectory(root);
    await localOperatorPrivateIo.ensureDirectory(directory);
    // Persist newly created directory entries as well as the later record file.
    await syncDirectory(root);
    await syncDirectory(input.authority.stateRoot);
  };
  const read = async () => {
    await ensure();
    let revision = 0;
    let previous: string | null = null;
    let record: PrivateComputeActivation | undefined;
    for (;;) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Read the complete immutable journal prefix in causal order.
      const content = await localOperatorPrivateIo.read(path.join(directory, `${revision}.json`));
      if (content === undefined) {
        break;
      }
      const entry = entrySchema.parse(JSON.parse(content));
      if (
        entry.revision !== revision ||
        entry.previous !== previous ||
        entry.record.sandboxId !== input.sandboxId ||
        (input.workspaceDrive !== undefined && entry.record.workspaceDrive !== input.workspaceDrive)
      ) {
        throw new Error(
          "The private compute resource journal does not match its preserved causal history.",
        );
      }
      previous = hash(content);
      ({ record } = entry);
      revision += 1;
    }
    await input.assertCurrent();
    return { previous, record, revision };
  };
  return {
    append: async (
      record: PrivateComputeActivation,
      expected: { revision: number; previous: string | null },
    ) => {
      await ensure();
      const latest = await read();
      if (latest.revision !== expected.revision || latest.previous !== expected.previous) {
        throw new Error(
          "The private compute resource journal advanced; read its pending outcome before another effect.",
        );
      }
      const content = JSON.stringify(entrySchema.parse({ ...expected, record }));
      await input.assertCurrent();
      if (
        !(await localOperatorPrivateIo.writeOnce(
          path.join(directory, `${expected.revision}.json`),
          content,
          true,
          true,
        ))
      ) {
        throw new Error(
          "Another compute operation already owns this journal position; no provider effect was sent.",
        );
      }
      const observed = await read();
      if (observed.revision !== expected.revision + 1 || observed.previous !== hash(content)) {
        throw new Error(
          "The compute intent did not receive its exact durable acknowledgement; no provider effect was sent.",
        );
      }
      return observed;
    },
    read,
  };
};
