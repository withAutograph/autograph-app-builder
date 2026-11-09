import { z } from "zod";
import type { HostedPrincipal } from "../eve/hosted-auth";
import type { createBuilderSessionDestinationService } from "./builder-session-destination";
import { builderDestinationEpochSchema } from "./builder-session-destination-contract";
import { builderProvisionRequestSchema } from "./contracts";

const newDestinationSelectionSchema = z.strictObject({
  sessionId: z.string().min(1),
  expected: builderDestinationEpochSchema,
  request: builderProvisionRequestSchema,
});
export const builderExistingRepositorySelectionSchema = z.strictObject({
  kind: z.literal("existing-repository"),
  sessionId: z.string().min(1),
  expected: builderDestinationEpochSchema,
  repository: z.string().trim().min(3).max(221),
  selectedInstallationId: z
    .string()
    .regex(/^[1-9][0-9]*$/u)
    .optional(),
});
export const builderSessionDestinationSelectionSchema = z.union([
  newDestinationSelectionSchema,
  builderExistingRepositorySelectionSchema,
]);
export interface BuilderSessionDestinationActionState {
  // oxlint-disable-next-line sonarjs/max-union-size -- Four distinct product action outcomes.
  status: "idle" | "ready" | "pending" | "error";
  message?: string;
  connectionUrl?: string;
}
export const createBuilderSessionDestinationAction =
  (ports: {
    origin: string;
    enabled: () => Promise<boolean>;
    open: (headers: Headers) => Promise<{
      principal: HostedPrincipal;
      service: Pick<ReturnType<typeof createBuilderSessionDestinationService>, "select"> & {
        selectExisting?: (
          input: z.infer<typeof builderExistingRepositorySelectionSchema> & {
            principal: HostedPrincipal;
          },
        ) => Promise<BuilderSessionDestinationActionState>;
      };
    }>;
    refresh: () => void;
  }) =>
  async (
    input: z.infer<typeof builderSessionDestinationSelectionSchema>,
    incoming: Headers,
  ): Promise<BuilderSessionDestinationActionState> => {
    try {
      const parsed = builderSessionDestinationSelectionSchema.parse(input);
      if (
        incoming.get("origin") !== ports.origin ||
        (!("kind" in parsed) && !(await ports.enabled()))
      ) {
        return {
          status: "error",
          message: "Destination setup is unavailable. Your build is preserved.",
        };
      }
      const context = await ports.open(incoming);
      if ("kind" in parsed) {
        if (context.service.selectExisting === undefined) {
          throw new Error("Existing destination selection is unavailable.");
        }
        const result = await context.service.selectExisting({
          ...parsed,
          principal: context.principal,
        });
        ports.refresh();
        return result;
      }
      const result = await context.service.select({ ...parsed, principal: context.principal });
      ports.refresh();
      return result.provisioning.vercel.status === "succeeded"
        ? { status: "ready", message: "Your app destination is ready. Continue the saved build." }
        : {
            status: "pending",
            message:
              "Destination setup is unfinished. Continue this same saved destination; do not start another build.",
          };
    } catch {
      return {
        status: "error",
        message:
          "Destination setup could not finish. Your build and saved request are preserved. Refresh this page to continue safely.",
      };
    }
  };
