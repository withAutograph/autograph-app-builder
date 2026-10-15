import { createHash } from "node:crypto";
import { HostedOperatorError } from "./hosted-operator-contract";
import type { HostedOperatorPlan } from "./hosted-operator-contract";

const exactHttpsOrigin = (value: string) => {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new HostedOperatorError("operator_unavailable");
  }
  return value;
};

/** The exact nonsensitive value written to PLATFORM_REALM_OPERATOR_LINK_CONFIG. */
export const createHostedOperatorRealmLinkConfig = (
  plan: Pick<HostedOperatorPlan, "gatewayBindings" | "normalActorProgram">,
) => {
  const bindings = plan.gatewayBindings;
  if (bindings === undefined) {
    throw new HostedOperatorError("operator_unavailable");
  }
  return {
    browserOrigin: exactHttpsOrigin(bindings.authBrowserOrigin),
    builderCallbackOrigin: exactHttpsOrigin(bindings.builderCallbackOrigin),
    builderCallbackPath: "/api/hosted-operator/realm-identity",
    operatorOrigin: exactHttpsOrigin(bindings.operatorOrigin),
    identityHandoff: { sender: bindings.sourceWorkload },
    readonlyAttesters: bindings.readonlyAttesters,
    ...(plan.normalActorProgram === undefined
      ? {}
      : {
          browserSessionCapture: {
            path: "/api/hosted-operator/realm-browser-session",
            sender: bindings.sourceWorkload,
          },
        }),
  };
};

export const hostedOperatorRealmLinkConfigSha256 = (
  plan: Pick<HostedOperatorPlan, "gatewayBindings" | "normalActorProgram">,
) =>
  createHash("sha256")
    .update(JSON.stringify(createHostedOperatorRealmLinkConfig(plan)))
    .digest("hex");
