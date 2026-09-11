/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";

import { persistBuilderDraft, readBuilderDraftResume } from "./builder-session";

const resumeKey = "1c7ed773-0aa9-4e32-9e65-6eb36e7b5cc0";

afterEach(() => sessionStorage.clear());

describe("provider draft recovery bridge", () => {
  it("retains the acknowledged server revision with the short-lived draft", () => {
    persistBuilderDraft(
      resumeKey,
      {
        appNameEditedByUser: true,
        connectedConnections: [],
        deploymentProvider: null,
        focusOrigin: "github",
        form: {
          appName: "Recovered App",
          brief: "Keep this acknowledged provider checkpoint.",
          buildDestination: "codex",
          connections: [],
          modelId: "openai/gpt-5.6-sol",
          privateRepository: true,
          repository: "recovered-app",
        },
        gitScope: "scope",
        model: "openai/gpt-5.6-sol",
        repositoryEditedByUser: true,
        search: "",
        showMoreConnections: false,
        storageProvider: "github",
        team: "team",
        version: 1,
        zdrOnly: false,
      },
      4
    );

    expect(readBuilderDraftResume(resumeKey)).toMatchObject({
      acknowledgedRevision: 4,
      draft: { form: { appName: "Recovered App" } },
    });
  });
});
