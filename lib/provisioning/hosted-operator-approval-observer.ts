import { createSameOriginEveTransport } from "../eve/same-origin-http";
import type { HostedEveTransport } from "../eve/hosted-service";
import type { HostedOperatorContext } from "./hosted-operator-service";
import { HostedOperatorError } from "./hosted-operator-contract";

type TransportOptions = Parameters<typeof createSameOriginEveTransport>[0];
type Observe = NonNullable<HostedEveTransport["observe"]>;

/** Restrict the verified carrier to the configured Builder's native stream. */
export const createBuilderApprovalStreamFetch =
  (input: {
    origin: string;
    adapterSessionId: string;
    signal: AbortSignal;
    fetchImplementation: typeof fetch;
  }): typeof fetch =>
  async (resource, init) => {
    input.signal.throwIfAborted();
    const url = new URL(resource instanceof Request ? resource.url : resource);
    const expected = new URL(
      `/eve/v1/session/${encodeURIComponent(input.adapterSessionId)}/stream`,
      input.origin,
    );
    if (
      url.origin !== expected.origin ||
      url.pathname !== expected.pathname ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw new HostedOperatorError("authorization_required");
    }
    const requestSignal = resource instanceof Request ? resource.signal : undefined;
    const signal = init?.signal === undefined ? requestSignal : init.signal;
    return await input.fetchImplementation(resource, {
      ...init,
      redirect: "manual",
      signal:
        signal === null || signal === undefined
          ? input.signal
          : AbortSignal.any([input.signal, signal]),
    });
  };

export const createHostedOperatorApprovalObserver = (input: {
  builderOrigin: string;
  workloadIdentity: TransportOptions["workloadIdentity"];
  verifyReadAuthority: NonNullable<TransportOptions["verifyReadAuthority"]>;
  fetchImplementation?: typeof fetch;
}) => {
  const options = {
    config: { baseUrl: input.builderOrigin },
    workloadIdentity: input.workloadIdentity,
    verifyReadAuthority: input.verifyReadAuthority,
    ...(input.fetchImplementation === undefined
      ? {}
      : { fetchImplementation: input.fetchImplementation }),
  };
  const ambient = createSameOriginEveTransport(options).observe;
  if (ambient === undefined) {
    throw new HostedOperatorError("operator_unavailable");
  }
  const capabilities = new WeakMap<object, { token: string; signal: AbortSignal }>();
  return {
    bindWorkload: (context: HostedOperatorContext, token: () => string, signal: AbortSignal) => {
      // Transport parsing/owner authorization produces this object per request.
      // Context spreads retain it; another request cannot inherit it through IDs.
      if (context.ownerContext !== undefined) {
        capabilities.set(context.ownerContext, { token: token(), signal });
      }
    },
    forContext(context: HostedOperatorContext): Observe {
      const capability =
        context.ownerContext === undefined ? undefined : capabilities.get(context.ownerContext);
      if (capability === undefined) {
        return ambient;
      }
      return async (request) => {
        capability.signal.throwIfAborted();
        const observe = createSameOriginEveTransport({
          ...options,
          workloadIdentity: { token: () => Promise.resolve(capability.token) },
          fetchImplementation: createBuilderApprovalStreamFetch({
            origin: input.builderOrigin,
            adapterSessionId: request.adapterSessionId,
            signal: capability.signal,
            fetchImplementation: input.fetchImplementation ?? fetch,
          }),
        }).observe;
        if (observe === undefined) {
          throw new HostedOperatorError("operator_unavailable");
        }
        return await observe(request);
      };
    },
  };
};
