import { z } from "zod";

export const appTenantBindingStatusSchema = z.enum([
  "principal_scope_denied",
  "actor_absent",
  "actor_inactive",
  "actor_active",
]);

/** Approved plan scopes only. An active actor row does not prove a particular request's fence. */
export const appTenantBindingReadbackSchema = z.strictObject({
  bindings: z.array(
    z.strictObject({
      appId: z.string().min(1),
      actorId: z.string().min(1),
      organizationId: z.string().min(1),
      role: z.string().min(1),
      status: appTenantBindingStatusSchema,
    }),
  ),
});
export type AppTenantBindingReadback = z.infer<typeof appTenantBindingReadbackSchema>;
