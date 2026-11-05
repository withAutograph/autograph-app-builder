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
  projectId: z.string().min(1),
  teamId: z.string().min(1),
  installationId: z.string().min(1),
  provisioningRequestId: z.uuid(),
  provisioningDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type BuilderPublicOriginScope = z.infer<typeof builderPublicOriginScopeSchema>;
export const builderPublicOriginSelectionSchema = z.strictObject({
  sessionId: z.string().min(1),
  expected: builderDestinationEpochSchema,
  scope: builderPublicOriginScopeSchema,
  publicOrigin: builderPublicOriginSchema,
  expectedPublicOrigin: builderPublicOriginSchema.nullable(),
});
export interface BuilderPublicOriginActionState {
  status: "idle" | "ready" | "error";
  message?: string;
}
