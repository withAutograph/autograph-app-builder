import type { WorkflowStepToolContext, WorkflowToolContext } from "eve/tools";
import type {
  HostedRuntimeApprovalEnvelope,
  prepareHostedRuntimeStep,
} from "./prepare-app-hosted-runtime-step";

type Preparation = Awaited<ReturnType<typeof prepareHostedRuntimeStep>>;
export type HostedRuntimeIdentityInput = NonNullable<Preparation["identityInput"]>;
export interface HostedRuntimeIdentityWake {
  eventId: string;
}
export interface HostedRuntimeIdentityWaitRegistration {
  token: string;
  identityInput: HostedRuntimeIdentityInput;
}
export interface HostedRuntimeIdentityWaitRegistered {
  status: "waiting" | "consumed" | "expired";
  eventId?: string;
  checkAfter?: string;
}
export interface HostedRuntimeIdentityWaitObserved {
  status: "consumed" | "expired";
  eventId: string;
}

interface IdentityHook extends PromiseLike<HostedRuntimeIdentityWake> {
  token: string;
  getConflict: () => PromiseLike<object | null>;
  dispose: () => void;
}
export interface HostedRuntimeIdentityWaitPorts {
  createHook: () => IdentityHook;
  register: (
    input: HostedRuntimeApprovalEnvelope,
    ctx: WorkflowToolContext,
    registration: HostedRuntimeIdentityWaitRegistration,
  ) => Promise<HostedRuntimeIdentityWaitRegistered>;
  acknowledge: (
    input: HostedRuntimeApprovalEnvelope,
    ctx: WorkflowToolContext,
    event: HostedRuntimeIdentityWake,
  ) => Promise<HostedRuntimeIdentityWaitObserved>;
  sleepUntil: (expiresAt: Date) => Promise<void>;
}

/**
 * A wake is only a notification; the same protected prepare remains authoritative.
 * @yields {object} The ordinary Auth invitation after the private event hook is registered.
 */
// oxlint-disable-next-line eslint/func-style -- An async generator preserves partial output and its terminal return separately.
export async function* continueHostedRuntimeOwnerPreparation(
  input: HostedRuntimeApprovalEnvelope,
  ctx: WorkflowToolContext,
  prepare: typeof prepareHostedRuntimeStep,
  ports: HostedRuntimeIdentityWaitPorts,
) {
  // Workflow step proxies serialize their receiver; keep function-bearing ports out of step arguments.
  const { createHook, register, acknowledge, sleepUntil } = ports;
  let prepared = await prepare(input, ctx);
  while (prepared.identityInput !== null) {
    const hook = createHook();
    try {
      // Registration must commit before a callback can discover the private token.
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each identity handoff has its own durable hook registration.
      if ((await hook.getConflict()) !== null) {
        throw new Error("The identity continuation hook is already registered.");
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- Bind this hook to the exact canonical pending identity request.
      const { identityInput } = prepared;
      const request = {
        token: hook.token,
        identityInput,
      };
      // oxlint-disable-next-line eslint/no-await-in-loop -- Register only after this hook commits.
      const registration = await register(input, ctx, request);
      let { eventId } = registration;
      if (registration.status === "waiting") {
        yield {
          ...prepared.result,
          authIdentityLink: prepared.identityInput.browserUrl,
          authIdentityLinkExpiresAt: prepared.identityInput.expiresAt,
          nextStep:
            "Sign in using the protected Auth link. The approved preparation resumes automatically.",
        };
        let observationAt = Date.parse(registration.checkAfter ?? identityInput.expiresAt);
        let observationDelay = 5000;
        while (eventId === undefined) {
          const observationDeadline = new Date(observationAt);
          // oxlint-disable-next-line eslint/no-await-in-loop -- Sleep is a Workflow wait, raced against the private server event.
          const wake = await Promise.race([
            Promise.resolve(hook),
            (async () => {
              await sleepUntil(observationDeadline);
              return null;
            })(),
          ]);
          if (wake === null) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- Canonical readback recovers a lost hook delivery and only server time can establish expiry.
            const observed = await register(input, ctx, request);
            eventId = observed.status === "waiting" ? undefined : observed.eventId;
            observationAt = Math.max(
              Date.parse(observed.checkAfter ?? identityInput.expiresAt),
              observationAt + observationDelay,
            );
            observationDelay = Math.min(observationDelay * 2, 30_000);
          } else {
            ({ eventId } = wake);
          }
        }
      }
      if (eventId === undefined) {
        throw new Error("The identity continuation has no canonical event receipt.");
      }
      // Local time never creates an expiry event: this step verifies the server receipt.
      // oxlint-disable-next-line eslint/no-await-in-loop -- Acknowledge the canonical receipt before continuing its approved preparation.
      await acknowledge(input, ctx, { eventId });
    } finally {
      hook.dispose();
    }
    // Reuse the original input and auth snapshot; neither the event nor browser reply grants authority.
    // oxlint-disable-next-line eslint/no-await-in-loop -- Canonical readback follows each callback, consumption, or expiry race.
    prepared = await prepare(input, ctx);
  }
  return prepared.result;
}

// oxlint-disable-next-line eslint/func-style -- Workflow steps must be top-level async declarations.
export async function registerHostedRuntimeIdentityWaitStep(
  input: HostedRuntimeApprovalEnvelope,
  ctx: WorkflowStepToolContext,
  registration: HostedRuntimeIdentityWaitRegistration,
): Promise<HostedRuntimeIdentityWaitRegistered> {
  "use step";
  const continuation = await import("../provisioning/hosted-operator-realm-continuation");
  return await continuation.registerHostedRuntimeIdentityWait({
    ...registration,
    input,
    sessionAuth: ctx.session.auth,
    adapterSessionId: ctx.session.id,
    callId: ctx.callId,
  });
}

// oxlint-disable-next-line eslint/func-style -- Workflow steps must be top-level async declarations.
export async function acknowledgeHostedRuntimeIdentityWaitStep(
  input: HostedRuntimeApprovalEnvelope,
  ctx: WorkflowStepToolContext,
  event: HostedRuntimeIdentityWake,
): Promise<HostedRuntimeIdentityWaitObserved> {
  "use step";
  const continuation = await import("../provisioning/hosted-operator-realm-continuation");
  return await continuation.acknowledgeHostedRuntimeIdentityWait({
    ...event,
    input,
    sessionAuth: ctx.session.auth,
    adapterSessionId: ctx.session.id,
    callId: ctx.callId,
  });
}
