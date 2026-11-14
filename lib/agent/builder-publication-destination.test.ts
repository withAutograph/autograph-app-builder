/* oxlint-disable eslint/require-await -- Async ports model canonical state reads. */
import { expect, it, vi } from "vitest";
import {
  confirmBuilderPublicationDestination,
  createBuilderPublicationDestinationReader,
} from "./builder-publication-destination";
import type { ExistingRepositoryDestination } from "../provisioning/builder-session-destination-contract";
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
    readProvisioning: async (input) => {
      reads += 1;
      expect(input.authority).toEqual(authority);
      return row;
    },
    readSelection: async () => {
      if (drift) {
        epoch += 1;
      }
      type Selection = Awaited<
        ReturnType<Parameters<typeof createBuilderPublicationDestinationReader>[0]["readSelection"]>
      >;
      const selected: Pick<Selection, "authority" | "appId" | "publicSessionId" | "destination"> = {
        appId: "saved-app",
        authority,
        publicSessionId: "saved-public-session",
      };
      if (!withoutDestination) {
        selected.destination = {
          appId: "saved-app",
          requestDigest: digest,
          requestId: request.requestId,
        };
      }
      return {
        ...selected,
        owner: { adapterGeneration: epoch },
      };
    },
  });
  return {
    drift: () => {
      drift = true;
    },
    read,
    reads: () => reads,
    row,
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

it("reads a selected existing repository without a resource provisioning journal", async () => {
  const selected = {
    authority: {
      issuer: "https://builder.example/auth",
      audience: "https://builder.example/mcp",
      workspaceId: "workspace",
      ownerUserId: "owner",
    },
    appId: "notes",
    publicSessionId: "saved",
    owner: { generation: 1 },
    destination: {
      kind: "existing-repository" as const,
      version: 1 as const,
      appId: "notes",
      repository: { repositoryId: "123", owner: "team", name: "apps", defaultBranch: "main" },
      installationId: "456",
      confirmedByCallId: "selected",
    },
  };
  const read = createBuilderPublicationDestinationReader({
    readSelection: async () => selected,
    readProvisioning: async () => {
      throw new Error("Existing repositories do not create resources");
    },
  });
  await expect(read()).resolves.toEqual({
    publicSessionId: "saved",
    destination: { repository: "team/apps", repositoryId: "123", selectedInstallationId: "456" },
  });
});

const publicationDestination: ExistingRepositoryDestination = {
  kind: "existing-repository",
  version: 1,
  appId: "notes",
  repository: { repositoryId: "123", owner: "team", name: "apps", defaultBranch: "main" },
  installationId: "456",
  confirmedByCallId: "current-review",
};

const destinationPorts = () => ({
  attach: vi.fn<() => Promise<void>>().mockResolvedValue(),
  readSaved: vi
    .fn<() => Promise<ExistingRepositoryDestination>>()
    .mockResolvedValue(publicationDestination),
});

it("continues an already selected exact destination without retrying its attachment", async () => {
  const ports = destinationPorts();
  ports.attach.mockRejectedValue(
    new Error("Builder destination selection requires settled session operations."),
  );
  const saved = { ...publicationDestination, confirmedByCallId: "initial-selection" };
  ports.readSaved.mockResolvedValue(saved);
  await expect(
    confirmBuilderPublicationDestination({
      ...ports,
      saved,
      destination: publicationDestination,
      requireExactReadback: true,
    }),
  ).resolves.toBeUndefined();
  expect(ports.attach).not.toHaveBeenCalled();
});

it.each([
  ["application", { appId: "other-app" }],
  ["installation", { installationId: "789" }],
  ["repository", { repository: { ...publicationDestination.repository, repositoryId: "789" } }],
  [
    "repository owner",
    { repository: { ...publicationDestination.repository, owner: "other-team" } },
  ],
  ["repository name", { repository: { ...publicationDestination.repository, name: "other-apps" } }],
  [
    "default branch",
    { repository: { ...publicationDestination.repository, defaultBranch: "develop" } },
  ],
])("refuses a changed saved %s without attempting attachment", async (_reason, changed) => {
  const ports = destinationPorts();
  await expect(
    confirmBuilderPublicationDestination({
      ...ports,
      saved: { ...publicationDestination, ...changed },
      destination: publicationDestination,
    }),
  ).rejects.toThrow();
  expect(ports.attach).not.toHaveBeenCalled();
});

it("attaches and verifies a new destination before direct publication", async () => {
  const ports = destinationPorts();
  ports.readSaved.mockImplementation(async () => {
    expect(ports.attach).toHaveBeenCalledTimes(1);
    return publicationDestination;
  });
  await confirmBuilderPublicationDestination({
    ...ports,
    destination: publicationDestination,
    requireExactReadback: true,
  });
  expect(ports.readSaved).toHaveBeenCalledTimes(1);
});

it("rejects a mismatched destination read back after initial attachment", async () => {
  const ports = destinationPorts();
  ports.readSaved.mockResolvedValue({ ...publicationDestination, installationId: "789" });
  await expect(
    confirmBuilderPublicationDestination({
      ...ports,
      destination: publicationDestination,
      requireExactReadback: true,
    }),
  ).rejects.toThrow();
  expect(ports.attach).toHaveBeenCalledTimes(1);
});

it("retains a provisioned destination for ordinary publication while enforcing exact Production readback", async () => {
  const ports = destinationPorts();
  const input = {
    ...ports,
    saved: {
      appId: publicationDestination.appId,
      requestId: "11111111-1111-4111-a111-111111111111",
      requestDigest: "a".repeat(64),
    },
    destination: publicationDestination,
  };
  await expect(confirmBuilderPublicationDestination(input)).resolves.toBeUndefined();
  await expect(
    confirmBuilderPublicationDestination({ ...input, requireExactReadback: true }),
  ).rejects.toThrow();
  expect(ports.attach).not.toHaveBeenCalled();
});
