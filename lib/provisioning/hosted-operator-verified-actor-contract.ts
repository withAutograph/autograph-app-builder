import { z } from "zod";

/** Only fresh verified session identity. No browser state, credentials or historical request proof. */
export const verifiedActorReadbackSchema = z.strictObject({
  requestCorrelation: z.literal("not_established"),
  actors: z.array(
    z.strictObject({
      actorKey: z.string().min(1),
      account: z.enum(["capture-existing", "create-email-password"]),
      email: z.email(),
      actorId: z.string().min(1),
      organizationId: z.string().nullable(),
      membershipRole: z.string().nullable(),
      appRoles: z.array(z.string()),
    }),
  ),
});
