/* oxlint-disable eslint/require-await -- Read-only controlled service responses model the transport boundary. */
import { describe, expect, it, vi } from "vitest";
import {
  githubProductionSetupContinuation,
  resolveGitHubProductionDeliveryReadiness,
} from "./github-production-delivery-readiness";
import type { RepositoryProductionDeliveryStatus } from "../provisioning/repository-production-delivery";

const target = { appId: "new-app", repositoryId: "123", repositoryFullName: "team/repository" };
const operationRef = "11111111-1111-4111-8111-111111111111";
const requirement = { ...target, operationRef };
const ready: RepositoryProductionDeliveryStatus = {
  version: 1,
  ...target,
  applicable: true,
  operationRef,
  state: "ready",
  preparationRequired: false,
};
const unmanaged: RepositoryProductionDeliveryStatus = { version: 1, ...target, applicable: false };
const fixture = () => ({
  target,
  operatorConfigured: true,
  requirements: [],
  read: vi.fn(async (): Promise<RepositoryProductionDeliveryStatus> => ready),
  retain: vi.fn(),
});

describe("managed Production delivery prerequisite", () => {
  it("keeps a deployment with no managed capability generic without contacting an unsupported service", async () => {
    const f = fixture();
    await expect(
      resolveGitHubProductionDeliveryReadiness({ ...f, operatorConfigured: false }),
    ).resolves.toEqual(unmanaged);
    expect(f.read).not.toHaveBeenCalled();
    expect(f.retain).not.toHaveBeenCalled();
  });

  it("does not forget an authoritative managed requirement when its endpoint disappears", async () => {
    const f = fixture();
    await expect(
      resolveGitHubProductionDeliveryReadiness({
        ...f,
        operatorConfigured: false,
        requirements: [requirement],
      }),
    ).rejects.toThrow("saved Production setup service");
    expect(f.read).not.toHaveBeenCalled();
  });

  it("accepts known unmanaged destinations only from a successful configured-service response", async () => {
    const f = fixture();
    f.read.mockResolvedValue(unmanaged);
    await expect(resolveGitHubProductionDeliveryReadiness(f)).resolves.toEqual(unmanaged);
    expect(f.read).toHaveBeenCalledOnce();
    expect(f.retain).not.toHaveBeenCalled();
  });

  it("does not turn loss of a previously managed profile into a generic bypass", async () => {
    const f = fixture();
    f.read.mockResolvedValue(unmanaged);
    await expect(
      resolveGitHubProductionDeliveryReadiness({ ...f, requirements: [requirement] }),
    ).rejects.toThrow("existing managed Production destination");
  });

  it("retains only the exact app/repository setup requirement returned by the service", async () => {
    const f = fixture();
    await expect(resolveGitHubProductionDeliveryReadiness(f)).resolves.toEqual(ready);
    expect(f.retain).toHaveBeenCalledExactlyOnceWith(requirement);
  });

  it.each(["appId", "repositoryId", "repositoryFullName"] as const)(
    "rejects another %s's ready result",
    async (field) => {
      const f = fixture();
      const value = {
        repositoryId: "999",
        repositoryFullName: "other/repository",
        appId: "other-app",
      }[field];
      f.read.mockResolvedValue({ ...ready, [field]: value });
      await expect(resolveGitHubProductionDeliveryReadiness(f)).rejects.toThrow(
        "this reviewed app and repository",
      );
      expect(f.retain).not.toHaveBeenCalled();
    },
  );

  it("preserves service authorization/transport failure instead of falling through to unmanaged", async () => {
    const f = fixture();
    const original = new Error("service unavailable");
    f.read.mockRejectedValue(original);
    await expect(resolveGitHubProductionDeliveryReadiness(f)).rejects.toBe(original);
    expect(f.retain).not.toHaveBeenCalled();
  });

  it.each(["setting-up-data", "checking-access", "identity-required", "reconciling"] as const)(
    "retains the same unfinished %s operation for normal continuation",
    async (state) => {
      const f = fixture();
      const pending: RepositoryProductionDeliveryStatus = {
        ...ready,
        applicable: true,
        state,
        preparationRequired: false,
      };
      f.read.mockResolvedValue(pending);
      await expect(resolveGitHubProductionDeliveryReadiness(f)).resolves.toEqual(pending);
      expect(githubProductionSetupContinuation(pending)).toEqual({
        tool: "get-app-production",
        input: { appId: target.appId },
      });
    },
  );

  it("uses the existing plan approval only when actual required setup is absent or changed", () => {
    expect(
      githubProductionSetupContinuation({ ...ready, applicable: true, preparationRequired: true }),
    ).toEqual({ tool: "plan-app-production", input: { appId: target.appId } });
  });
});
