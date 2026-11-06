import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BuilderFormContent } from "./builder-form-content";
import { BuilderControllerContext } from "./builder-form-context";
import type { useBuilderController } from "./use-builder-controller";

const controller = {
  addConnection: () => {},
  appNameEditedByUser: { current: false },
  autosave: null,
  beginProviderConnection: () => {},
  briefExamples: [],
  builderForm: { register: () => ({ name: "field" }) },
  canSubmit: true,
  comingSoonEnabled: false,
  completeConnection: () => {},
  connectedConnections: [],
  connectionFlow: null,
  deploymentProvider: null,
  draftSaveError: "",
  draftSyncNotice: "",
  form: {
    appName: "Example app",
    brief: "Describe the app",
    buildDestination: "codex",
    connections: [],
    privateRepository: true,
    repository: "example-app",
  },
  generatedAppName: { current: null },
  gitScope: "",
  gitScopeOptions: [],
  integrations: {
    github: { scopes: [], status: "unavailable" },
    models: { entries: [], status: "unavailable" },
    vercel: { scopes: [], status: "unavailable" },
  },
  interactive: true,
  model: "",
  modelOptions: [],
  preparingSubmission: false,
  removeConnection: () => {},
  repositoryEditedByUser: { current: false },
  repositoryNameFromAppName: (name: string) => name,
  router: { refresh: () => {} },
  search: "",
  setConnectionFlow: () => {},
  setDeploymentProvider: () => {},
  setDraftSaveError: () => {},
  setForm: () => {},
  setGitScope: () => {},
  setModel: () => {},
  setSearch: () => {},
  setShowMoreConnections: () => {},
  setSourceUploadPending: () => {},
  setStorageProvider: () => {},
  setTeam: () => {},
  setZdrOnly: () => {},
  showMoreConnections: false,
  sourceUploadPending: false,
  storageProvider: null,
  submissionPending: false,
  submit: () => {},
  submitGuidance: "",
  team: "",
  teamOptions: [],
  updateBrief: () => {},
  visibleProviderNotices: [],
  zdrOnly: false,
} satisfies ReturnType<typeof useBuilderController>;

const builderContent = (connectionsEnabled: boolean) =>
  renderToStaticMarkup(
    <BuilderControllerContext value={controller}>
      <BuilderFormContent connectionsEnabled={connectionsEnabled} />
    </BuilderControllerContext>,
  );

describe("server-composed builder content", () => {
  it("owns the title and section structure independently of client state", () => {
    const html = builderContent(false);
    expect(html).toContain("<h1>Build an app</h1>");
    expect(html).toContain("Describe what you want to build");
    for (const section of ["app-details", "build-with", "store-in", "deploy-to"]) {
      expect(html.match(new RegExp(`data-create-app-section="${section}"`, "gu"))).toHaveLength(1);
    }
    expect(html).not.toContain('data-create-app-section="connections"');
    expect(html).toContain("Where do you want to store this app?");
    expect(html).toContain("Where do you want to deploy this app?");
  });

  it("composes the optional connections section from the server flag", () => {
    const html = builderContent(true);
    expect(html).toContain('data-create-app-section="connections"');
    expect(html).toContain("Give this app access to tools and data from other services.");
  });
});
