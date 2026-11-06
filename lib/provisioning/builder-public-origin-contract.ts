import { z } from "zod";
import { builderDestinationEpochSchema } from "./builder-session-destination-contract";

export const builderPublicOriginSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" && url.origin === value && url.username === "" && url.password === ""
  );
});
export const builderPublicOriginScopeSchema = z.strictObject({
  appId: z.string().min(1),
  installationId: z.string().min(1),
  projectId: z.string().min(1),
  provisioningDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  provisioningRequestId: z.uuid(),
  teamId: z.string().min(1),
});
export type BuilderPublicOriginScope = z.infer<typeof builderPublicOriginScopeSchema>;
export const builderPublicOriginSelectionSchema = z.strictObject({
  expected: builderDestinationEpochSchema,
  expectedPublicOrigin: builderPublicOriginSchema.nullable(),
  publicOrigin: builderPublicOriginSchema,
  scope: builderPublicOriginScopeSchema,
  sessionId: z.string().min(1),
});
export interface BuilderPublicOriginActionState {
  status: "idle" | "ready" | "error";
  message?: string;
}
