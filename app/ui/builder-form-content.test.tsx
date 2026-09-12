import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { BuilderFormContent } from "./builder-form-content";

// These are RSC client references in production. Test the independently
// renderable server structure without hydrating a draft or auth provider.
vi.mock("./builder-form-islands", () => ({
  BuilderAppDetails: () => <input aria-label="App Name" />,
  BuilderConnections: () => <button type="button">Add a connection</button>,
  BuilderDeployment: () => <button type="button">Choose deployment</button>,
  BuilderDestination: () => <button type="button">Choose destination</button>,
  BuilderModel: () => null,
  BuilderProviderNotices: () => null,
  BuilderStorage: () => <button type="button">Choose storage</button>,
  BuilderSubmit: () => <button type="submit">Create App</button>,
}));

describe("server-composed builder content", () => {
  it("owns the title and section structure independently of client state", () => {
    const html = renderToStaticMarkup(<BuilderFormContent connectionsEnabled={false} />);
    expect(html).toContain("<h1>Build an app</h1>");
    expect(html).toContain("Describe what you want to build");
    for (const section of ["app-details", "build-with", "store-in", "deploy-to"]) {
      expect(html.match(new RegExp(`data-create-app-section="${section}"`, "g"))).toHaveLength(1);
    }
    expect(html).not.toContain('data-create-app-section="connections"');
    expect(html).toContain("Where do you want to store this app?");
    expect(html).toContain("Where do you want to deploy this app?");
  });

  it("composes the optional connections section from the server flag", () => {
    const html = renderToStaticMarkup(<BuilderFormContent connectionsEnabled />);
    expect(html).toContain('data-create-app-section="connections"');
    expect(html).toContain("Give this app access to tools and data from other services.");
  });
});
