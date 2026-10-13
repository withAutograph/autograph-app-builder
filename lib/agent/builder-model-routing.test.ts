import { createHash } from "node:crypto";

import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activeBuilderModelId, builderValidationModelId } from "../integrations/active-model";
import { builderModelConfiguration, builderModelForPhase } from "./builder-model-routing";
import { APP_BUILDER_WORKFLOW_VERSION, appBuilderWorkflowState } from "./workflow-state";
import type { AppBuilderWorkflowState } from "./workflow-state";

const discoveryPhases = ["empty", "prepared", "ui_previewed", "ui_accepted"] as const;
const authoringPhases = [
  "app_spec_accepted",
  "dependencies_prepared",
  "identity_resolved",
  "planned",
  "apply_failed",
  "applied",
  "validation_pending",
  "validation_failed",
  "validated",
  "reviewed",
  "publication_pending",
  "publication_failed",
  "published_local",
  "branch_publication_pending",
  "branch_publication_failed",
  "published_branch_worktree",
  "fresh_bootstrap_pending",
  "fresh_bootstrap_failed",
  "published_fresh_bootstrap",
] as const satisfies readonly AppBuilderWorkflowState["phase"][];

// SAFETY: The tested resolver consumes only this valid workflow phase and never accesses artifact payloads.
const savedState = (phase: AppBuilderWorkflowState["phase"]) =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Narrow fixture for the phase-only state reader.
  ({ phase, version: APP_BUILDER_WORKFLOW_VERSION }) as AppBuilderWorkflowState;

const context = {
  channel: {},
  messages: [],
  model: null,
  session: { auth: { current: null, initiator: null }, id: "saved-session" },
};

const nativeModel = (localDevelopment = false) => {
  const configuration = builderModelConfiguration({ localDevelopment });
  const agent = defineAgent(configuration);
  const { model } = agent;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Inspect the native authored static/dynamic union in this test.
  if (typeof model !== "object" || !("kind" in model)) {
    throw new Error("Expected Eve's native dynamic model definition.");
  }
  const handler = model.events["step.started"];
  if (handler === undefined) {
    throw new Error("Expected a native step.started callback.");
  }
  return { configuration, handler, model };
};

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {
    // Capture metadata without writing fixture diagnostics to the test output.
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Builder model routing", () => {
  it.each(discoveryPhases)("retains Luna during %s", (phase) => {
    expect(builderModelForPhase(phase)).toBe(activeBuilderModelId);
  });

  it.each(authoringPhases)("uses Sol during %s", (phase) => {
    expect(builderModelForPhase(phase)).toBe(builderValidationModelId);
  });

  it("reads saved state only when the native step callback runs, including later phase advances", async () => {
    const state = vi.spyOn(appBuilderWorkflowState, "get");
    const { configuration, handler, model } = nativeModel();
    expect(state).not.toHaveBeenCalled();
    expect(model.kind).toBe("eve:dynamic");
    expect(Object.keys(model.events)).toEqual(["step.started"]);
    expect(configuration).not.toHaveProperty("modelContextWindowTokens");
    expect(configuration).not.toHaveProperty("modelOptions");

    // A resumed saved session is already past discovery when its first step starts.
    state.mockReturnValue(savedState("app_spec_accepted"));
    expect(await handler({ type: "step.started" }, context)).toEqual({
      model: builderValidationModelId,
      modelContextWindowTokens: 128_000,
      modelOptions: {
        providerOptions: { gateway: { only: ["openai"], order: ["openai"] } },
      },
      reasoning: "high",
    });
    state.mockReturnValue(savedState("validation_failed"));
    expect(await handler({ type: "step.started" }, context)).toMatchObject({
      model: builderValidationModelId,
    });
    expect(state).toHaveBeenCalledTimes(2);
  });

  it("switches from UI approval to authoring within the same native definition", async () => {
    const state = vi.spyOn(appBuilderWorkflowState, "get");
    const { handler } = nativeModel(true);
    state.mockReturnValue(savedState("ui_accepted"));
    expect(await handler({ type: "step.started" }, context)).toMatchObject({
      model: activeBuilderModelId,
      modelContextWindowTokens: 128_000,
      reasoning: "low",
    });
    state.mockReturnValue(savedState("app_spec_accepted"));
    expect(await handler({ type: "step.started" }, context)).toMatchObject({
      model: builderValidationModelId,
      reasoning: "low",
    });
  });

  it("logs only selected phase/model and a stable hashed native session identity at callback time", async () => {
    const state = vi.spyOn(appBuilderWorkflowState, "get");
    const { handler } = nativeModel();
    expect(console.info).not.toHaveBeenCalled();
    const rawSessionId = "private-native-session-id";
    const privatePayload = "private-provider-message-auth-source-secret";
    const diagnosticContext = {
      ...context,
      channel: { metadata: { privatePayload } },
      messages: [{ content: privatePayload, role: "user" as const }],
      session: { ...context.session, id: rawSessionId },
    };
    const sessionIdHash = `sha256:${createHash("sha256").update(rawSessionId).digest("hex")}`;
    state.mockReturnValue(savedState("ui_accepted"));
    await handler({ privatePayload, type: "step.started" }, diagnosticContext);
    expect(console.info).toHaveBeenNthCalledWith(1, "[builder:model-selection]", {
      event: "builder.model_selection",
      modelId: activeBuilderModelId,
      phase: "ui_accepted",
      sessionIdHash,
    });
    state.mockReturnValue(savedState("app_spec_accepted"));
    await handler({ privatePayload, type: "step.started" }, diagnosticContext);
    expect(console.info).toHaveBeenNthCalledWith(2, "[builder:model-selection]", {
      event: "builder.model_selection",
      modelId: builderValidationModelId,
      phase: "app_spec_accepted",
      sessionIdHash,
    });
    expect(state).toHaveBeenCalledTimes(2);
    expect(console.info).toHaveBeenCalledTimes(2);
    const logged = JSON.stringify(vi.mocked(console.info).mock.calls);
    expect(logged).not.toContain(rawSessionId);
    expect(logged).not.toContain(privatePayload);
    expect(sessionIdHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("keeps native selection unchanged when the diagnostic sink throws", async () => {
    vi.mocked(console.info).mockImplementation(() => {
      throw new Error("diagnostic sink unavailable");
    });
    vi.spyOn(appBuilderWorkflowState, "get").mockReturnValue(savedState("validation_failed"));
    const { handler } = nativeModel();
    expect(await handler({ type: "step.started" }, context)).toEqual({
      model: builderValidationModelId,
      modelContextWindowTokens: 128_000,
      modelOptions: {
        providerOptions: { gateway: { only: ["openai"], order: ["openai"] } },
      },
      reasoning: "high",
    });
  });

  it.each([true, false])("preserves the static mock branch (local=%s)", (localDevelopment) => {
    const state = vi.spyOn(appBuilderWorkflowState, "get");
    const testModel = mockModel(() => "fixture");
    const agent = defineAgent(builderModelConfiguration({ localDevelopment, testModel }));
    expect(agent.model).toBe(testModel);
    expect(agent.modelContextWindowTokens).toBe(128_000);
    expect(agent.reasoning).toBe(localDevelopment ? "low" : "high");
    expect(agent).not.toHaveProperty("modelOptions");
    expect(state).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();
  });
});
