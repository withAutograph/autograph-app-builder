import { z } from "zod";
import type { HostedPrincipal } from "../eve/hosted-auth";
import type { createBuilderSessionDestinationService } from "./builder-session-destination";
import { builderDestinationEpochSchema } from "./builder-session-destination-contract";
import { builderProvisionRequestSchema } from "./contracts";

export const builderSessionDestinationSelectionSchema = z.strictObject({
  expected: builderDestinationEpochSchema,
  request: builderProvisionRequestSchema,
  sessionId: z.string().min(1),
});
export interface BuilderSessionDestinationActionState {
  // oxlint-disable-next-line sonarjs/max-union-size -- Four distinct product action outcomes.
  status: "idle" | "ready" | "pending" | "error";
  message?: string;
}
export const createBuilderSessionDestinationAction =
  (ports: {
    origin: string;
    enabled: () => Promise<boolean>;
    open: (headers: Headers) => Promise<{
      principal: HostedPrincipal;
      service: Pick<ReturnType<typeof createBuilderSessionDestinationService>, "select">;
    }>;
    refresh: () => void;
  }) =>
  async (
    input: z.infer<typeof builderSessionDestinationSelectionSchema>,
    incoming: Headers,
  ): Promise<BuilderSessionDestinationActionState> => {
    try {
      const parsed = builderSessionDestinationSelectionSchema.parse(input);
      if (incoming.get("origin") !== ports.origin || !(await ports.enabled())) {
        return {
          message: "Destination setup is unavailable. Your build is preserved.",
          status: "error",
        };
      }
      const context = await ports.open(incoming);
      const result = await context.service.select({ ...parsed, principal: context.principal });
      ports.refresh();
      return result.provisioning.vercel.status === "succeeded"
        ? { message: "Your app destination is ready. Continue the saved build.", status: "ready" }
        : {
            message:
              "Destination setup is unfinished. Continue this same saved destination; do not start another build.",
            status: "pending",
          };
    } catch {
      return {
        message:
          "Destination setup could not finish. Your build and saved request are preserved. Refresh this page to continue safely.",
        status: "error",
      };
    }
  };
