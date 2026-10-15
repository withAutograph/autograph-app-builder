import type { HostedPrincipal } from "../eve/hosted-auth";

export interface RealmContinuationRead {
  principal: HostedPrincipal;
  sessionId: string;
  adapterSessionId: string;
  sourceHandoffId?: string;
}

export type ResumeRealmContinuation = (
  input: RealmContinuationRead & {
    environment?: Readonly<Record<string, string | undefined>>;
  },
) => Promise<void>;

/** Recovery uses the already authorized read's exact public/native binding. */
export const createRealmContinuationRead =
  (input: {
    environment: Readonly<Record<string, string | undefined>>;
    resume?: ResumeRealmContinuation;
  }) =>
  async (read: RealmContinuationRead): Promise<void> => {
    try {
      const request = { ...read, environment: input.environment };
      if (input.resume !== undefined) {
        await input.resume(request);
        return;
      }
      const { reconcileHostedOperatorRealmContinuation } =
        await import("../provisioning/hosted-operator-realm-continuation");
      await reconcileHostedOperatorRealmContinuation(request);
    } catch {
      // The durable dispatch stays pending or unknown. A recovery failure cannot
      // hide the saved build or claim that its account connection succeeded.
    }
  };
