import { expect, it, vi } from "vitest";
import { planPublicAppWithGuidance } from "./public-release-planning";
import { plan } from "../provisioning/public-release-test-fixture";
import {
  publicReleaseOperationRef,
  publicReleasePlanDigest,
} from "../provisioning/public-release-contract";
import { PublicReleasePrerequisiteError } from "../provisioning/public-release-prerequisite";

type Client = Parameters<typeof planPublicAppWithGuidance>[0];

it("returns the canonical saved session destination control after public planning discovers no destination", async () => {
  const client = {
    plan: vi
      .fn<Client["plan"]>()
      .mockRejectedValue(new PublicReleasePrerequisiteError("builder_destination_required")),
    sessionId: "saved/public?session",
  };
  const result = await planPublicAppWithGuidance(client, "invoice-app");
  expect(result).toMatchObject({
    authenticatedBehavior: "unassessed",
    code: "builder_destination_required",
    destinationPath: "/builds/saved%2Fpublic%3Fsession/destination",
    status: "blocked",
  });
  expect(result).toHaveProperty("nextAction", expect.stringContaining("does not approve"));
  expect(client.plan).toHaveBeenCalledExactlyOnceWith("invoice-app");
});
it("keeps a runtime prerequisite on the same app without offering another destination", async () => {
  const client = {
    plan: vi
      .fn<Client["plan"]>()
      .mockRejectedValue(new PublicReleasePrerequisiteError("prepared_runtime_required")),
    sessionId: "saved-session",
  };
  const result = await planPublicAppWithGuidance(client, "invoice-app");
  expect(result).toMatchObject({ code: "prepared_runtime_required", status: "blocked" });
  expect(result).not.toHaveProperty("destinationPath");
});
it("preserves successful plans and unexpected failures without repeating the request", async () => {
  const planned = {
    operationRef: publicReleaseOperationRef(plan),
    plan,
    planDigest: publicReleasePlanDigest(plan),
  };
  const client = {
    plan: vi.fn<Client["plan"]>().mockResolvedValue(planned),
    sessionId: "saved-session",
  };
  expect(await planPublicAppWithGuidance(client, "invoice-app")).toBe(planned);
  const failure = new Error("authorization-required");
  client.plan.mockRejectedValue(failure);
  await expect(planPublicAppWithGuidance(client, "invoice-app")).rejects.toBe(failure);
  expect(client.plan).toHaveBeenCalledTimes(2);
});
