import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBuilderSessionDestinationAction } from "../../lib/provisioning/builder-session-destination-action";

const fixture = { enabled: vi.fn(), open: vi.fn(), refresh: vi.fn(), select: vi.fn() };
let incoming = new Headers();
const action = createBuilderSessionDestinationAction({
  origin: "https://builder.example",
  ...fixture,
});
const selectBuilderSessionDestination = async (input: Parameters<typeof action>[0]) =>
  await action(input, incoming);
const input = {
  expected: { adapterGeneration: 1, adapterSessionId: "saved-adapter", cancellationRevision: 0 },
  request: {
    appName: "saved-app",
    deploymentAccess: "public-app" as const,
    operation: "vercel" as const,
    providers: { vercelInstallationId: "installation" },
    repository: { name: "saved-app", private: true },
    requestId: "be05a1b9-92d0-4a16-832b-3309a5594244",
    version: 1 as const,
  },
  sessionId: "saved-session",
};
beforeEach(() => {
  vi.clearAllMocks();
  incoming = new Headers({ origin: "https://builder.example" });
  fixture.enabled.mockResolvedValue(true);
  fixture.open.mockResolvedValue({
    principal: { ownerUserId: "trusted-owner" },
    service: { select: fixture.select },
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
