import { z } from "zod";

const dateTime = z.iso.datetime({ offset: true });
const productionAppLink = z
  .url()
  .max(1024)
  .refine((value) => {
    const url = new URL(value);
    const hasExtras = [url.username, url.password, url.search, url.hash].some(Boolean);
    const privateHost =
      url.hostname === "vercel-infra.com" || url.hostname.endsWith(".vercel-infra.com");
    return url.protocol === "https:" && !hasExtras && !privateHost;
  });

export const deliveryProgressSchema = z.strictObject({
  phase: z.enum(["waiting-for-checks", "deploying", "updating-data", "live"]),
  disposition: z.enum(["active", "retrying", "intervention-required"]),
  startedAt: dateTime,
  observedAt: dateTime,
  appUrl: productionAppLink.optional(),
});

export type DeliveryProgress = z.infer<typeof deliveryProgressSchema>;

export const deliveryProgressLabels = {
  "waiting-for-checks": "Waiting for checks",
  deploying: "Deploying",
  "updating-data": "Updating app data",
  live: "Live",
} satisfies Record<DeliveryProgress["phase"], string>;

const availabilityHelp = "Continue the saved Builder session to review availability.";
const deliveryInterventionHelp = {
  "waiting-for-checks": "Open the pull request to review the required checks.",
  "updating-data": "Continue the saved Builder session to review the database update.",
  deploying: availabilityHelp,
  live: availabilityHelp,
} satisfies Record<DeliveryProgress["phase"], string>;

export const deliveryProgressDetail = ({ phase, disposition }: DeliveryProgress) => {
  if (disposition === "retrying") {
    return "Builder is checking again.";
  }
  return disposition === "intervention-required" ? deliveryInterventionHelp[phase] : undefined;
};
