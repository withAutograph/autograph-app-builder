import { z } from "zod";

const id = z.string().min(1);
const roles = z.array(id);
const link = z.url().refine((value) => new URL(value).protocol === "https:");

const request = z.object({ clientRequestId: z.uuid() });
export const appAccessActionSchema = z.discriminatedUnion("action", [
  request.extend({ action: z.literal("invite"), email: z.email(), roles }),
  request.extend({ action: z.literal("resend"), invitationId: id }),
  request.extend({ action: z.literal("cancel"), invitationId: id }),
  request.extend({ action: z.literal("change-role"), memberId: id, roles }),
  request.extend({ action: z.literal("remove"), memberId: id }),
  request.extend({ action: z.literal("renew-sign-in") }),
  request.extend({ action: z.literal("retry-setup") }),
  request.extend({ action: z.literal("choose-creator-account"), email: z.email() }),
]);
export type AppAccessAction = z.infer<typeof appAccessActionSchema>;
export const appAccessCommandSchema = appAccessActionSchema;
export type { AppAccessAction as AppAccessCommand };
export type AppAccessIntent = AppAccessAction extends infer Action
  ? Action extends AppAccessAction
    ? Omit<Action, "clientRequestId">
    : never
  : never;

export const appAccessSnapshotSchema = z.object({
  sessionId: id,
  appId: id,
  appName: id,
  organizationName: id,
  appUrl: link.optional(),
  canManage: z.boolean(),
  pendingCommand: appAccessCommandSchema.optional(),
  nextCursor: z.string().min(1).optional(),
  roles: z.array(z.object({ id, label: id })),
  members: z.array(z.object({ id, name: z.string(), email: z.email(), roles })),
  invitations: z.array(
    z.object({
      id,
      email: z.email(),
      roles,
      status: z.enum(["pending", "expired"]),
      deliveryStatus: z.enum(["ready", "sending", "sent", "unknown"]).optional(),
      expiresAt: z.iso.datetime({ offset: true }),
    }),
  ),
  creator: z.object({
    status: z.enum(["ready", "sign_in_required", "setting_up", "failed"]),
    email: z.email().optional(),
    canChooseAccount: z.boolean().optional(),
    signInUrl: link.optional(),
    recoveryUrl: link.optional(),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    message: z.string().optional(),
    retryable: z.boolean().optional(),
  }),
});
export type AppAccessSnapshot = z.infer<typeof appAccessSnapshotSchema>;

export const appAccessFailureSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
});

export const appAccessPath = (sessionId: string): string =>
  `/builds/${encodeURIComponent(sessionId)}/access`;
export const appAccessApiPath = (sessionId: string): string =>
  `/api/builder/sessions/${encodeURIComponent(sessionId)}/access`;
