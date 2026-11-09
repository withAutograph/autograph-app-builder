import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBuilderSessionDestinationAction } from "../../lib/provisioning/builder-session-destination-action";

const fixture = {
  open: vi.fn(),
  select: vi.fn(),
  selectExisting: vi.fn(),
  enabled: vi.fn(),
  refresh: vi.fn(),
};
let incoming = new Headers();
const action = createBuilderSessionDestinationAction({
  origin: "https://builder.example",
  ...fixture,
});
const selectBuilderSessionDestination = async (input: Parameters<typeof action>[0]) =>
  await action(input, incoming);
const input = {
  sessionId: "saved-session",
  expected: { adapterGeneration: 1, adapterSessionId: "saved-adapter", cancellationRevision: 0 },
  request: {
    version: 1 as const,
    operation: "vercel" as const,
    appName: "saved-app",
    deploymentAccess: "public-app" as const,
    requestId: "be05a1b9-92d0-4a16-832b-3309a5594244",
    providers: { vercelInstallationId: "installation" },
    repository: { name: "saved-app", private: true },
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  incoming = new Headers({ origin: "https://builder.example" });
  fixture.enabled.mockResolvedValue(true);
  fixture.open.mockResolvedValue({
    principal: { ownerUserId: "trusted-owner" },
    service: { select: fixture.select, selectExisting: fixture.selectExisting },
  });
  fixture.select.mockResolvedValue({ provisioning: { vercel: { status: "succeeded" } } });
});
describe("saved session destination Server Action", () => {
  it("uses authenticated owner authority instead of accepting it from the browser", async () => {
    await expect(selectBuilderSessionDestination(input)).resolves.toMatchObject({
      status: "ready",
    });
    expect(fixture.select).toHaveBeenCalledWith({
      ...input,
      principal: { ownerUserId: "trusted-owner" },
    });
    expect(fixture.refresh).toHaveBeenCalledOnce();
  });
  it("rejects a foreign origin before any destination or provisioning operation", async () => {
    incoming = new Headers({ origin: "https://foreign.example" });
    await expect(selectBuilderSessionDestination(input)).resolves.toMatchObject({
      status: "error",
    });
    expect(fixture.open).not.toHaveBeenCalled();
    expect(fixture.select).not.toHaveBeenCalled();
  });
  it("does not retry an interrupted provider operation", async () => {
    fixture.select.mockRejectedValue(new Error("unknown outcome"));
    await expect(selectBuilderSessionDestination(input)).resolves.toMatchObject({
      status: "error",
    });
    expect(fixture.select).toHaveBeenCalledOnce();
  });
});

it("allows existing repository selection when resource creation is disabled", async () => {
  fixture.enabled.mockResolvedValue(false);
  fixture.selectExisting.mockResolvedValue({ status: "ready", message: "Repository selected" });
  const request = {
    kind: "existing-repository" as const,
    sessionId: input.sessionId,
    expected: input.expected,
    repository: "https://github.com/team/apps",
  };
  await expect(selectBuilderSessionDestination(request)).resolves.toMatchObject({
    status: "ready",
  });
  expect(fixture.selectExisting).toHaveBeenCalledWith({
    ...request,
    principal: { ownerUserId: "trusted-owner" },
  });
  expect(fixture.select).not.toHaveBeenCalled();
});

it("retains the feature switch for new repository and project creation", async () => {
  fixture.enabled.mockResolvedValue(false);
  await expect(selectBuilderSessionDestination(input)).resolves.toMatchObject({ status: "error" });
  expect(fixture.open).not.toHaveBeenCalled();
});
