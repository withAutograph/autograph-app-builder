import type { DynamicResolveContext } from "eve/tools";
import { z } from "zod";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { exactForwardedSessionAuthority } from "../hosted/session-authority";

/** Discovery metadata only: the operator independently enforces administrator authority. */
export const authSchemaRolloutAvailable = (
  session: DynamicResolveContext["session"],
  environment?: { PRODUCTION_AUTH_SCHEMA_ROLLOUT_ADMINISTRATORS?: string },
) => {
  const configured =
    environment === undefined
      ? process.env.PRODUCTION_AUTH_SCHEMA_ROLLOUT_ADMINISTRATORS
      : environment.PRODUCTION_AUTH_SCHEMA_ROLLOUT_ADMINISTRATORS;
  if (configured === undefined || configured === "") {
    return false;
  }
  try {
    const administrators = z.array(hostedTenantAuthoritySchema).parse(JSON.parse(configured));
    const { authority } = exactForwardedSessionAuthority(session.auth);
    return administrators.some((administrator) =>
      (["issuer", "audience", "workspaceId", "ownerUserId"] as const).every(
        (field) => administrator[field] === authority[field],
      ),
    );
  } catch {
    return false;
  }
};
