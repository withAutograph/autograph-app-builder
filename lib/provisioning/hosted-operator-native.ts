import { createProtectedHostedOperatorHandler } from "./hosted-operator-service";
import type { ProtectedHostedOperatorDependencies } from "./hosted-operator-service";
import { reportHostedOperatorNativeFailure } from "./hosted-operator-native-diagnostic";
import type { HostedOperatorNativeFailureStage } from "./hosted-operator-native-diagnostic";

export interface HostedOperatorRequestDependencies {
  dependencies: ProtectedHostedOperatorDependencies;
  close: () => Promise<void>;
}
export type HostedOperatorRequestDependencyLoader = (
  request: Request,
) => Promise<HostedOperatorRequestDependencies>;

export type HostedOperatorDependencyLoader = () => Promise<ProtectedHostedOperatorDependencies>;
type Handler = ReturnType<typeof createProtectedHostedOperatorHandler>;
const unavailable = () =>
  Response.json(
    { code: "protected_operator_required" },
    { headers: { "cache-control": "no-store" }, status: 503 },
  );

/** Trusted source composition only. No request/environment value chooses a factory. */
export const createHostedOperatorNativeHandler = (
  input: {
    createDependencies?: HostedOperatorDependencyLoader;
    createRequestDependencies?: HostedOperatorRequestDependencyLoader;
  } = {},
): Handler => {
  let initializing: Promise<Handler> | null = null;
  const initialize = async (): Promise<Handler> => {
    if (input.createDependencies === undefined) {
      throw new Error("Protected operator composition is unavailable");
    }
    if (initializing === null) {
      const loader = input.createDependencies;
      initializing = (async () => createProtectedHostedOperatorHandler(await loader()))();
    }
    const pending = initializing;
    try {
      return await pending;
    } catch (error) {
      // A failed initialization is not a successful host or a permanent receipt.
      if (initializing === pending) {
        initializing = null;
      }
      throw error;
    }
  };
  return async (request: Request) => {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/runtime") {
      return Response.json(
        { code: "not_found" },
        { headers: { "cache-control": "no-store" }, status: 404 },
      );
    }
    if (input.createRequestDependencies !== undefined) {
      let scoped: HostedOperatorRequestDependencies | undefined;
      let stage: HostedOperatorNativeFailureStage = "native_request_dependencies";
      try {
        scoped = await input.createRequestDependencies(request);
        stage = "native_handler_dispatch";
        return await createProtectedHostedOperatorHandler(scoped.dependencies)(request);
      } catch (error) {
        reportHostedOperatorNativeFailure(stage, error);
        return unavailable();
      } finally {
        // Releasing this request's connection pool cannot turn a committed effect into a retry.
        try {
          await scoped?.close();
        } catch {
          // The operation response remains authoritative after resource disposal fails.
        }
      }
    }
    let handler: Handler;
    try {
      handler = await initialize();
    } catch (error) {
      reportHostedOperatorNativeFailure("native_fallback_initialize", error);
      return unavailable();
    }
    // The existing operator owns workload/owner authorization, approval, leases,
    // effects and readback. This host adapter supplies only native HTTP delivery.
    return await handler(request);
  };
};
