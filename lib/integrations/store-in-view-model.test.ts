import { describe, expect, it } from "vitest";

import {
  githubRepositoryAccessSchema,
  githubRepositoryAccessViewModel,
  githubStoreInViewModel,
} from "./store-in-view-model";

describe("GitHub Store In view model", () => {
  it("distinguishes a first connection from an access update", () => {
    expect(
      githubStoreInViewModel({
        action: "connect",
        desiredRepository: "withAutograph/app-builder-dogfood",
      }),
    ).toMatchObject({
      actionLabel: "Connect GitHub",
      description:
        "Connect GitHub so Autograph can access withAutograph/app-builder-dogfood.",
      scopeSummary: "No GitHub account connected yet",
    });

    expect(
      githubStoreInViewModel({
        action: "update",
        desiredRepository: "withAutograph/app-builder-dogfood",
        scopes: [
          {
            id: "123",
            label: "withAutograph",
            detail: "Organization",
          },
        ],
      }),
    ).toMatchObject({
      actionLabel: "Update GitHub access",
      description:
        "Update GitHub access to include withAutograph/app-builder-dogfood.",
      scopeSummary: "Connected to withAutograph",
    });
  });

  it("keeps repository and scope metadata closed and internally consistent", () => {
    const access = {
      provider: "github" as const,
      action: "update" as const,
      repository: {
        owner: "withAutograph",
        name: "app-builder-dogfood",
        fullName: "withAutograph/app-builder-dogfood",
      },
      scopes: [
        {
          installationId: "123",
          accountLogin: "withAutograph",
          accountType: "Organization" as const,
        },
      ],
    };
    expect(githubRepositoryAccessSchema.parse(access)).toEqual(access);
    expect(githubRepositoryAccessViewModel(access)).toMatchObject({
      action: "update",
      desiredRepository: "withAutograph/app-builder-dogfood",
      scopes: [{ id: "123", label: "withAutograph", detail: "Organization" }],
    });
    expect(
      githubRepositoryAccessSchema.safeParse({
        ...access,
        repository: { ...access.repository, fullName: "other/repository" },
      }).success,
    ).toBe(false);
    expect(
      githubRepositoryAccessSchema.safeParse({
        ...access,
        providerToken: "must-not-be-public",
      }).success,
    ).toBe(false);
  });
});
