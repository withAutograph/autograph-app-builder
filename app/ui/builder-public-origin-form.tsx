"use client";

import { builderPublicOriginSchema } from "../../lib/provisioning/builder-public-origin-contract";
import { useActionState } from "react";
import type { selectBuilderSessionPublicOrigin } from "../actions/builder-session-destination";
import type {
  BuilderPublicOriginActionState,
  BuilderPublicOriginScope,
} from "../../lib/provisioning/builder-public-origin-contract";
import type { BuilderDestinationEpoch } from "../../lib/provisioning/builder-session-destination-contract";

export const BuilderPublicOriginForm = (props: {
  sessionId: string;
  scope: BuilderPublicOriginScope;
  expected: BuilderDestinationEpoch;
  origins: readonly string[];
  selectedPublicOrigin: string | null;
  submit: typeof selectBuilderSessionPublicOrigin;
}) => {
  const [state, action, pending] = useActionState<BuilderPublicOriginActionState, FormData>(
    async (_state, data) => {
      const parsed = builderPublicOriginSchema.safeParse(data.get("publicOrigin"));
      if (!parsed.success) {
        return { message: "Choose a verified production domain.", status: "error" };
      }
      return await props.submit({
        expected: props.expected,
        expectedPublicOrigin: props.selectedPublicOrigin,
        publicOrigin: parsed.data,
        scope: props.scope,
        sessionId: props.sessionId,
      });
    },
    { status: "idle" },
  );
  return (
    <section aria-labelledby="public-domain-heading">
      <h2 id="public-domain-heading">App public domain</h2>
      <p>
        This domain opens without a Vercel account. The app’s own sign-in controls access. Choosing
        it does not approve Auth setup, publication, or deployment.
      </p>
      {props.origins.length === 0 ? (
        <p>No verified production domain is available on this app’s project.</p>
      ) : (
        <form action={action}>
          <label htmlFor="builder-public-origin">Verified production domain</label>
          <select
            id="builder-public-origin"
            name="publicOrigin"
            defaultValue={props.selectedPublicOrigin ?? ""}
            disabled={pending}
            required
          >
            <option value="" disabled>
              Choose a domain
            </option>
            {props.origins.map((origin) => (
              <option key={origin} value={origin}>
                {origin}
              </option>
            ))}
          </select>
          <button type="submit" disabled={pending}>
            {pending ? "Saving domain…" : "Use this public domain"}
          </button>
        </form>
      )}
      {state.message === undefined ? null : <p role="status">{state.message}</p>}
    </section>
  );
};
