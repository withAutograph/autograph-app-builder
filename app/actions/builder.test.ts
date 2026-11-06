import { describe, expect, it } from "vitest";
import { continueBuilderHandoff, continueHandoffProvisioning } from "./builder";

describe("builder server action input validation", () => {
  it("rejects malformed continuation input before reading server state", async () => {
    expect(
      await continueBuilderHandoff(undefined, {
        creationRequestId: "123e4567-e89b-42d3-a456-426614174002",
        draftCheckpoint: {
          draftId: "123e4567-e89b-42d3-a456-426614174003",
          revision: 4,
        },
        form: {
          appName: "Server Action App",
          brief: "Build this with a durable server action.",
          buildDestination: "codex",
          connections: [],
          modelId: "openai/gpt-5.6-sol",
          privateRepository: true,
          repository: "server-action-app",
        },
        provisioningEnabled: true,
        requestId: "not-a-uuid",
        version: 1,
      }),
    ).toEqual({ status: "error" });
  });

  it("rejects malformed continuation identifiers before reading handoff state", async () => {
    expect(
      await continueHandoffProvisioning(undefined, {
        handoffId: "not-a-uuid",
      }),
    ).toEqual({ status: "error" });
  });
});
