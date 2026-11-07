/* oxlint-disable eslint/require-await -- Async ports model canonical state reads. */
import { expect, it } from "vitest";
import { createBuilderPublicationDestinationReader } from "./builder-publication-destination";
import { initialBuilderProvisionJournalRecord } from "../provisioning/journal";
import type { BuilderProvisionJournalRow } from "../provisioning/journal";
import { builderProvisionRequestDigest } from "../provisioning/contracts";

const fixture = (withoutDestination = false) => {
  const authority = {
    issuer: "https://builder.example/auth",
    audience: "https://builder.example/mcp",
    workspaceId: "workspace",
    ownerUserId: "owner",
  };
  const request = {
    version: 1 as const,
    operation: "vercel" as const,
    appName: "saved-app",
    requestId: "11111111-1111-4111-a111-111111111111",
    repository: { name: "saved-app", private: true },
    providers: { githubInstallationId: "456", vercelInstallationId: "vercel-installation" },
  };
  const digest = builderProvisionRequestDigest(request);
  const record = initialBuilderProvisionJournalRecord(request, new Date());
  record.response.github = {
    status: "succeeded",
    defaultBranch: "main",
    fullName: "owner/saved-app",
    headSha: "a".repeat(40),
    headTree: "b".repeat(40),
    installationId: "456",
    name: "saved-app",
    owner: "owner",
    repositoryId: "123",
    scope: { id: "987", login: "owner", type: "organization" },
    starter: { sourceSha: "a".repeat(40), sourceTree: "b".repeat(40) },
    url: "https://github.com/owner/saved-app",
    visibility: "private",
  };
  record.response.vercel = {
    status: "succeeded",
    dashboardUrl: "https://vercel.com/team/apps-saved-app",
    framework: "services",
    installationId: "vercel-installation",
    linkedGitHubRepository: "owner/saved-app",
    name: "apps-saved-app",
    projectId: "prj_app",
    rootDirectory: ".",
    scope: { id: "team", slug: "team", type: "team" },
  };
  const row: BuilderProvisionJournalRow = {
    authority,
    requestId: request.requestId,
    requestDigest: digest,
    state: "settled",
    revision: 4,
    record,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  let epoch = 1;
  let drift = false;
  let reads = 0;
  const read = createBuilderPublicationDestinationReader({
    readSelection: async () => {
      if (drift) {
        epoch += 1;
      }
      return {
        authority,
        appId: "saved-app",
        publicSessionId: "saved-public-session",
        ...(withoutDestination
          ? {}
          : {
              destination: {
                appId: "saved-app",
                requestId: request.requestId,
                requestDigest: digest,
              },
            }),
        owner: { adapterGeneration: epoch },
      };
    },
    readProvisioning: async (input) => {
      reads += 1;
      expect(input.authority).toEqual(authority);
      return row;
    },
  });
  return {
    read,
    row,
    drift: () => {
      drift = true;
    },
    reads: () => reads,
  };
};
it("selects the saved Builder-created destination without changing starter provenance or performing writes", async () => {
  const f = fixture();
  expect(await f.read()).toEqual({
    destination: {
      repository: "owner/saved-app",
      repositoryId: "123",
      selectedInstallationId: "456",
    },
    publicSessionId: "saved-public-session",
  });
  expect(f.reads()).toBe(2);
});
it("retains the public build identity when there is no destination to read", async () => {
  const f = fixture(true);
  expect(await f.read()).toEqual({ publicSessionId: "saved-public-session" });
  expect(f.reads()).toBe(0);
});
it.each(["pending", "app", "link"] as const)("refuses %s provisioning receipts", async (kind) => {
  const f = fixture();
  if (kind === "pending") {
    f.row.state = "pending";
  }
  if (kind === "app") {
    f.row.record.response.appId = "other-app";
  }
  if (kind === "link" && f.row.record.response.vercel.status === "succeeded") {
    f.row.record.response.vercel.linkedGitHubRepository = "owner/shared-template";
  }
  await expect(f.read()).rejects.toThrow("unavailable for publication");
});
it("rejects cancellation or recovery generation drift during review selection", async () => {
  const f = fixture();
  f.drift();
  await expect(f.read()).rejects.toThrow("changed during publication review");
});
