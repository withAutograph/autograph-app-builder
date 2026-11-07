import { z } from "zod";

import { operatorPublicResultSchema } from "../provisioning/hosted-operator-contract";

const captureOutcome = z.enum(["retained", "ineligible", "invalid_reference", "failed"]);
const referenceState = z.enum(["absent", "invalid", "present"]);
const diagnosticBoolean = z.boolean();

export type HostedRuntimeHandoffDiagnostic =
  | { stage: "hook_module_loaded" }
  | {
      stage: "owner_action_result";
      eventCompleted: boolean;
      isError: boolean;
      output: unknown;
    }
  | { stage: "reference_capture"; outcome: z.infer<typeof captureOutcome> }
  | {
      stage: "owner_selection_read";
      referenceState: z.infer<typeof referenceState>;
      selectionPresent?: boolean;
    }
  | {
      stage: "native_preview_candidate";
      acceptedAppIdPresent: boolean;
      inputAppIdPresent: boolean;
      lookupAttempted: boolean;
      appIdMatches?: boolean;
    };

type OwnerActionResultDiagnostic = Extract<
  HostedRuntimeHandoffDiagnostic,
  { stage: "owner_action_result" }
>;
interface HandoffDataProperty {
  value: unknown;
}

const ownDataProperty = (
  input: OwnerActionResultDiagnostic,
  key: string,
): HandoffDataProperty | undefined => {
  const { output } = input;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Inspect only the runtime output's own data descriptors; object parsing could invoke getters.
  if (output === null || typeof output !== "object") {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(output, key);
  return descriptor !== undefined && Object.hasOwn(descriptor, "value")
    ? { value: descriptor.value }
    : undefined;
};

const projectOutputKind = (input: OwnerActionResultDiagnostic) => {
  if (input.output === null) {
    return "null";
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Emit a fixed type label for the untrusted output without reading its properties.
  const outputType = typeof input.output;
  if (outputType === "object") {
    return "object";
  }
  if (outputType === "string") {
    return "string";
  }
  return "other";
};

const projectOutputStatus = (status: HandoffDataProperty | undefined) => {
  if (status === undefined) {
    return "missing";
  }
  const parsed = operatorPublicResultSchema.shape.status.safeParse(status.value);
  return parsed.success ? parsed.data : "invalid";
};

const projectActionResult = (input: OwnerActionResultDiagnostic) => {
  const status = ownDataProperty(input, "status");
  const appId = ownDataProperty(input, "appId");
  const operationRef = ownDataProperty(input, "operationRef");
  const planDigest = ownDataProperty(input, "planDigest");
  return {
    appIdPresent: appId !== undefined,
    appIdValid: operatorPublicResultSchema.shape.appId.safeParse(appId?.value).success,
    eventCompleted: diagnosticBoolean.parse(input.eventCompleted),
    isError: diagnosticBoolean.parse(input.isError),
    operationRefPresent: operationRef !== undefined,
    operationRefValid: operatorPublicResultSchema.shape.operationRef
      .unwrap()
      .safeParse(operationRef?.value).success,
    outputKind: projectOutputKind(input),
    outputStatus: projectOutputStatus(status),
    planDigestPresent: planDigest !== undefined,
    planDigestValid: operatorPublicResultSchema.shape.planDigest
      .unwrap()
      .safeParse(planDigest?.value).success,
    statusPresent: status !== undefined,
  };
};

/** Project closed metadata only; diagnostics cannot affect handoff or tool behavior. */
export const reportHostedRuntimeHandoffDiagnostic = (
  input: HostedRuntimeHandoffDiagnostic,
): void => {
  try {
    const event = "autograph.hosted-runtime.handoff-diagnostic";
    switch (input.stage) {
      case "hook_module_loaded": {
        // Module evaluation alone does not establish registry attachment or owner context.
        console.info(JSON.stringify({ event, stage: "hook_module_loaded" }));
        break;
      }
      case "owner_action_result": {
        console.info(
          JSON.stringify({
            event,
            stage: "owner_action_result",
            ...projectActionResult(input),
          }),
        );
        break;
      }
      case "reference_capture": {
        const outcome = captureOutcome.safeParse(input.outcome);
        if (outcome.success) {
          console.info(
            JSON.stringify({ event, outcome: outcome.data, stage: "reference_capture" }),
          );
        }
        break;
      }
      case "owner_selection_read": {
        const state = referenceState.safeParse(input.referenceState);
        if (state.success) {
          const base = {
            event,
            referenceState: state.data,
            stage: "owner_selection_read" as const,
          };
          const diagnostic =
            input.selectionPresent === undefined
              ? base
              : { ...base, selectionPresent: diagnosticBoolean.parse(input.selectionPresent) };
          console.info(JSON.stringify(diagnostic));
        }
        break;
      }
      case "native_preview_candidate": {
        const base = {
          acceptedAppIdPresent: diagnosticBoolean.parse(input.acceptedAppIdPresent),
          event,
          inputAppIdPresent: diagnosticBoolean.parse(input.inputAppIdPresent),
          lookupAttempted: diagnosticBoolean.parse(input.lookupAttempted),
          stage: "native_preview_candidate" as const,
        };
        const diagnostic =
          input.appIdMatches === undefined
            ? base
            : { ...base, appIdMatches: diagnosticBoolean.parse(input.appIdMatches) };
        console.info(JSON.stringify(diagnostic));
        break;
      }
      default: {
        break;
      }
    }
  } catch {
    // Accessors, proxies, schema failures, and logging failures remain advisory.
  }
};
