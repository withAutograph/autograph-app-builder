import { z } from "zod";

export const retainedBinModeRepairExecution = z.strictObject({
  operation: z.literal("repair"),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  files: z
    .array(
      z
        .string()
        .max(180)
        .regex(/^[A-Za-z0-9_./-]+$/u),
    )
    .min(1)
    .max(32),
});

export const retainedBinModeRepairInput = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("inspect") }),
  retainedBinModeRepairExecution,
]);

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Validate the native approval input before projecting it.
export const retainedBinModeRepairDescription = (input: unknown) => {
  const repair = retainedBinModeRepairExecution.safeParse(input);
  const paths = repair.success
    ? repair.data.files.map((file) => `- ${file}`).join("\n")
    : undefined;
  return paths === undefined
    ? undefined
    : `Restore the previous 0755 executable permissions on these unchanged private preview files. This does not apply the declined app plan or publish anything.\n\n${paths}`;
};
