import {
  HostedOperatorError,
  assertOperatorNativePreview,
} from "../provisioning/hosted-operator-contract";
import type { hostedOperatorClientForSession } from "../provisioning/hosted-operator-client";
import type { PreparedRuntimeExecution } from "./prepared-runtime-execution";

type Bindings = Awaited<
  ReturnType<Awaited<ReturnType<typeof hostedOperatorClientForSession>>["bindings"]>
>;
/** Publish only the selected app route on the verified canonical browser origin. */
export const nativeWorkingPreview = (input: {
  appId: string;
  baseRoute: string;
  landingPath: string;
  bindings: Pick<Bindings, "nativePreview" | "operationRef" | "plan" | "proof">;
  now?: number;
}) => {
  const preview = input.bindings.nativePreview;
  if (!preview) {
    throw new HostedOperatorError("resource_mismatch");
  }
  assertOperatorNativePreview(preview, input.bindings.plan, input.bindings.operationRef, input.now);
  if (input.appId !== input.bindings.plan.selection.appId) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const route = input.baseRoute;
  const path = input.landingPath === "/" ? route : input.landingPath;
  const url = new URL(path, preview.publicOrigin);
  const invalid = [
    route === "/",
    !route.startsWith("/"),
    route.startsWith("//"),
    route.includes(":"),
    !path.startsWith("/"),
    path.startsWith("//"),
    path.includes("\\"),
    url.origin !== preview.publicOrigin,
    url.hash !== "",
    url.pathname !== route && !url.pathname.startsWith(`${route}/`),
  ];
  if (invalid.includes(true)) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const { proof } = input.bindings;
  const installationProof: PreparedRuntimeExecution["installationProof"] = {
    ...proof,
    appId: input.appId,
    authenticatedBehavior: "unassessed",
    branch: input.bindings.plan.selection.branch,
    environment: "preview",
    observation: "database-verification",
    observedAt: preview.verifiedAt,
  };
  return {
    installationProof,
    workingPreview: {
      appId: input.appId,
      expiresAt: preview.expiresAt,
      status: "ready" as const,
      url: url.href,
      verifiedAt: preview.verifiedAt,
    },
  };
};
