/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";

import {
  persistBuilderDraft,
  readBuilderDraftResume,
} from "./builder-session";

const resumeKey = "1c7ed773-0aa9-4e32-9e65-6eb36e7b5cc0";

afterEach(() => sessionStorage.clear());

describe("provider draft recovery bridge", () => {
  it("retains the acknowledged server revision with the short-lived draft", () => {
    persistBuilderDraft(
      resumeKey,
      {
        version: 1,
        form: {
          appName: "Recovered App",
          repository: "recovered-app",
          brief: "Keep this acknowledged provider checkpoint.",
          privateRepository: true,
          buildDestination: "codex",
          connections: [],
          modelId: "openai/gpt-5.6-sol",
        },
        team: "team",
        gitScope: "scope",
        model: "openai/gpt-5.6-sol",
        zdrOnly: false,
        showMoreConnections: false,
        search: "",
        connectedConnections: [],
        storageProvider: "github",
        deploymentProvider: null,
        focusOrigin: "github",
        appNameEditedByUser: true,
        repositoryEditedByUser: true,
      },
      4,
    );

    expect(readBuilderDraftResume(resumeKey)).toMatchObject({
      acknowledgedRevision: 4,
      draft: { form: { appName: "Recovered App" } },
    });
  });
});
