import { readAuthenticatedSourceUploadContext } from "@/lib/handoff/source-upload-deployment";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { continueBuilderHandoff, continueHandoffProvisioning } from "./builder";
import { getAuthenticatedBuilderDraftContext } from "@/lib/builder-drafts/deployment";
import {
  getBuilderHandoffDeploymentHandler,
  getBuilderHandoffPageData,
} from "@/lib/handoff/deployment";

const providerInputs: unknown[] = [];
const sourceRead =
  vi.fn<(...args: never[]) => Promise<{ manifest: { appId: string } } | undefined>>();
const calls: string[] = [];
const drafts = { archive: vi.fn(), read: vi.fn() };
const draftId = "123e4567-e89b-42d3-a456-426614174003";
const storedForm = {
  appName: "Server Action App",
  brief: "Build this with a durable server action.",
  buildDestination: "codex",
  connections: [],
  githubInstallationId: "101",
  modelId: "openai/gpt-5.6-sol",
  privateRepository: true,
  repository: "server-action-app",
  vercelInstallationId: "vercel-team",
};
const input = {
  creationRequestId: "123e4567-e89b-42d3-a456-426614174002",
  draftCheckpoint: { draftId, revision: 4 },
  provisioningEnabled: true,
  requestId: "123e4567-e89b-42d3-a456-426614174000",
  version: 1 as const,
};

const context = {
  authority: {
    audience: "https://app.test/mcp",
    issuer: "https://app.test",
    ownerUserId: "user",
    workspaceId: "workspace",
  },
  drafts,
};
beforeEach(() => {
  providerInputs.length = 0;
  vi.mocked(getAuthenticatedBuilderDraftContext).mockResolvedValue(context);
  drafts.read.mockResolvedValue({
    draftId,
    record: { draft: { form: storedForm }, version: 1 },
    revision: 4,
    status: "active",
  });
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  drafts.archive.mockImplementation(async () => {
    calls.push("archive");
    return true;
  });
});

afterEach(() => {
  calls.splice(0);
  vi.clearAllMocks();
});

describe("continueBuilderHandoff", () => {
  it("verifies uploaded ownership before provisioning and preserves app ID independently of display name", async () => {
    const reference = {
      appId: "supplier-spend",
      kind: "application-source-candidate-v1",
      manifestDigest: "a".repeat(64),
      uploadId: "123e4567-e89b-42d3-a456-426614174099",
    };
    drafts.read.mockResolvedValueOnce({
      draftId,
      record: {
        draft: {
          form: { ...storedForm, appName: "Different display name", sourceCandidate: reference },
        },
      },
      revision: 4,
    });
    const current = await getAuthenticatedBuilderDraftContext({
      environment: process.env,
      headers: new Headers(),
    });
    if (current === undefined) {
      throw new Error("Expected signed-in draft context");
    }
    sourceRead.mockResolvedValue({ manifest: { appId: "supplier-spend" } });
    vi.mocked(readAuthenticatedSourceUploadContext).mockResolvedValue({
      authority: current.authority,
      store: { readCompleted: sourceRead },
    });
    expect(await continueBuilderHandoff(undefined, input)).toMatchObject({ status: "ready" });
    expect(sourceRead).toHaveBeenCalledWith(expect.objectContaining({ reference }));
    expect(providerInputs[0]).toMatchObject({ appName: "supplier-spend" });
  });
  it("denies an incomplete or foreign source before any provider reservation", async () => {
    const reference = {
      appId: "supplier-spend",
      kind: "application-source-candidate-v1",
      manifestDigest: "a".repeat(64),
      uploadId: "123e4567-e89b-42d3-a456-426614174099",
    };
    drafts.read.mockResolvedValueOnce({
      draftId,
      record: { draft: { form: { ...storedForm, sourceCandidate: reference } } },
      revision: 4,
    });
    vi.mocked(readAuthenticatedSourceUploadContext).mockResolvedValue(globalThis.undefined);
    expect(await continueBuilderHandoff(undefined, input)).toEqual({ status: "error" });
    expect(calls).toEqual([]);
  });
  it("accepts only an opaque checkpoint, never a second client form payload", async () => {
    // SAFETY: The extra form field is intentionally outside the action's accepted input contract.
    const malformedInput = { ...input, form: storedForm };
    expect(await continueBuilderHandoff(undefined, malformedInput)).toEqual({ status: "error" });
    expect(drafts.read).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
  it("reserves provisioning before creating the durable handoff", async () => {
    const result = await continueBuilderHandoff(undefined, input);

    expect(calls).toEqual(["reserve:github", "handoff", "archive"]);
    expect(drafts.read).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: "user", workspaceId: "workspace" }),
      draftId,
    );
    expect(drafts.archive).toHaveBeenCalledWith(expect.any(Object), draftId, 4);
    expect(result).toMatchObject({
      handoff: { handoffId: "123e4567-e89b-42d3-a456-426614174001" },
      provisioning: {
        github: { status: "succeeded" },
        vercel: { status: "skipped" },
      },
      status: "ready",
    });
  });

  it("rejects a stale checkpoint before creating provider resources or a handoff", async () => {
    expect(
      await continueBuilderHandoff(undefined, {
        ...input,
        draftCheckpoint: { draftId, revision: 3 },
      }),
    ).toEqual({ status: "error" });
    expect(calls).toEqual([]);
    expect(drafts.archive).not.toHaveBeenCalled();
  });

  it("rejects missing tenant authority before reading a draft", async () => {
    vi.mocked(getAuthenticatedBuilderDraftContext).mockResolvedValueOnce();
    expect(await continueBuilderHandoff(undefined, input)).toEqual({ status: "error" });
    expect(drafts.read).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("rejects an inaccessible draft before provider work", async () => {
    drafts.read.mockResolvedValueOnce();
    expect(await continueBuilderHandoff(undefined, input)).toEqual({ status: "error" });
    expect(calls).toEqual([]);
  });

  it("retains the draft when durable handoff creation fails", async () => {
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    vi.mocked(getBuilderHandoffDeploymentHandler).mockReturnValueOnce(async () =>
      Response.json({ error: "unavailable" }, { status: 503 }),
    );
    expect(await continueBuilderHandoff(undefined, input)).toEqual({ status: "error" });
    expect(drafts.archive).not.toHaveBeenCalled();
  });

  it("preserves a newer draft when conditional archival loses to another save", async () => {
    drafts.archive.mockResolvedValueOnce(false);
    expect(await continueBuilderHandoff(undefined, input)).toMatchObject({ status: "ready" });
    expect(drafts.archive).toHaveBeenCalledWith(expect.any(Object), draftId, 4);
  });

  it("rejects malformed input before it reaches a deployment handler", async () => {
    // SAFETY: The malformed request ID intentionally violates the action's UUID input contract.
    const malformedInput = {
      creationRequestId: "123e4567-e89b-42d3-a456-426614174002",
      form: {
        appName: "Server Action App",
        brief: "Build this with a durable server action.",
        buildDestination: "codex",
        connections: [],
        modelId: "openai/gpt-5.6-sol",
        privateRepository: true,
        repository: "server-action-app",
      },
      provisioningEnabled: false,
      requestId: "not-a-uuid",
      version: 1,
    };
    const result = await continueBuilderHandoff(undefined, malformedInput);

    expect(result).toEqual({ status: "error" });
    expect(calls).toEqual([]);
  });
});

describe("saved provisioning access policy", () => {
  it.each([undefined, "public-app"] as const)(
    "preserves %s through handoff continuation",
    async (deploymentAccess) => {
      vi.mocked(getBuilderHandoffPageData).mockResolvedValueOnce({
        intent: {
          appName: storedForm.appName,
          providers: { vercelInstallationId: storedForm.vercelInstallationId },
          provisioning: deploymentAccess === undefined ? {} : { deploymentAccess },
          provisioningRequestId: input.requestId,
          repository: { private: true, requestedName: storedForm.repository },
        },
      });
      expect(
        await continueHandoffProvisioning(undefined, {
          handoffId: "123e4567-e89b-42d3-a456-426614174001",
        }),
      ).toEqual({ status: "updated" });
      expect(providerInputs).toHaveLength(1);
      expect(providerInputs[0]?.deploymentAccess).toBe(deploymentAccess);
    },
  );
  it("reserves new web projects with public app access", async () => {
    expect(await continueBuilderHandoff(undefined, input)).toMatchObject({ status: "ready" });
    expect(providerInputs[0]?.deploymentAccess).toBe("public-app");
  });
});
