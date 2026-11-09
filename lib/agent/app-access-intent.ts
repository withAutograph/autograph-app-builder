import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

const approvedEmailEligibility = "approved-email";

/** Product intent only. The Production operator binds the resource, app and approved roles. */
export const appAccessIntentSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("private") }),
  z
    .strictObject({
      mode: z.literal("self-signup"),
      eligibility: z.enum(["public", approvedEmailEligibility]),
      allowedEmails: z.array(z.email().transform((email) => email.toLowerCase())).optional(),
      appRoles: z.array(z.string().min(1)),
    })
    .superRefine((value, context) => {
      if (
        value.eligibility === approvedEmailEligibility &&
        (value.allowedEmails?.length ?? 0) === 0
      ) {
        context.addIssue({
          code: "custom",
          message: "Approved-email signup needs eligible emails.",
        });
      }
      if (value.eligibility === "public" && (value.allowedEmails?.length ?? 0) > 0) {
        context.addIssue({
          code: "custom",
          message: "Public signup cannot also declare an approved-email restriction.",
        });
      }
      if (
        new Set(value.appRoles).size !== value.appRoles.length ||
        new Set(value.allowedEmails).size !== (value.allowedEmails ?? []).length
      ) {
        context.addIssue({
          code: "custom",
          message: "Signup roles and eligible emails must be unique.",
        });
      }
    }),
]);
export type AppAccessIntent = z.infer<typeof appAccessIntentSchema>;

export const appAccessIntentFields = (access: AppAccessIntent | undefined) =>
  access === undefined ? {} : { access };

/** Explain the access effects before the existing Production setup approval. */
export const describeAppAccessIntent = (appId: string, access: AppAccessIntent | undefined) => {
  if (access === undefined || access.mode === "private") {
    return `Private access to ${appId}: the creator and explicitly invited users. Self-signup is disabled.`;
  }
  const eligibility =
    access.eligibility === "public"
      ? "anyone with a verified email address"
      : `verified email addresses on the approved list: ${(access.allowedEmails ?? []).join(", ")}`;
  const roles =
    access.appRoles.length === 0 ? "app entry without app-data roles" : access.appRoles.join(", ");
  return `Self-signup to ${appId}: ${eligibility}. New users receive only this app's access: ${roles}.`;
};

/** Absent legacy intent is private. Ordinary revisions retain the recorded access choice. */
export const resolveAppAccessIntent = (
  requested: AppAccessIntent | undefined,
  existing: AppAccessIntent | undefined,
): AppAccessIntent | undefined => {
  const selected = requested ?? existing;
  if (selected === undefined) {
    return undefined;
  }
  const parsed = appAccessIntentSchema.parse(selected);
  if (parsed.mode === "private") {
    return parsed;
  }
  const access: Extract<AppAccessIntent, { mode: "self-signup" }> = {
    mode: parsed.mode,
    eligibility: parsed.eligibility,
    appRoles: [...parsed.appRoles].toSorted(),
  };
  if (parsed.eligibility === approvedEmailEligibility) {
    access.allowedEmails = [...(parsed.allowedEmails ?? [])].toSorted();
  }
  return access;
};

const normalizeAppAccessIntent = (value: AppAccessIntent | undefined): AppAccessIntent => {
  if (value === undefined || value.mode === "private") {
    return { mode: "private" };
  }
  const access: Extract<AppAccessIntent, { mode: "self-signup" }> = {
    mode: value.mode,
    eligibility: value.eligibility,
    appRoles: [...value.appRoles].toSorted(),
  };
  if (value.eligibility === approvedEmailEligibility) {
    access.allowedEmails = [...(value.allowedEmails ?? [])]
      .map((email) => email.toLowerCase())
      .toSorted();
  }
  return access;
};

export const sameAppAccessIntent = (
  first: AppAccessIntent | undefined,
  second: AppAccessIntent | undefined,
) => isDeepStrictEqual(normalizeAppAccessIntent(first), normalizeAppAccessIntent(second));
