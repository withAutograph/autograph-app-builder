import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectionsSection } from "./builder-connections";
import { DeployToSection, StoreInSection } from "./builder-provider-controls";

const ignoreChange = () => undefined;

describe("builder control islands", () => {
  it("renders provider controls without duplicating server-owned section shells", () => {
    const markup = renderToStaticMarkup(
      <>
        <StoreInSection
          bare
          available
          connected={false}
          gitScope=""
          gitScopeOptions={[]}
          onConnect={ignoreChange}
          onGitScopeChange={ignoreChange}
          onPrivacyChange={ignoreChange}
          onProviderChange={ignoreChange}
          onRepositoryChange={ignoreChange}
          privateRepository
          repository=""
          selected="github"
        />
        <DeployToSection
          bare
          available
          connected={false}
          onConnect={ignoreChange}
          onProviderChange={ignoreChange}
          onTeamChange={ignoreChange}
          selected="vercel"
          team=""
          teamOptions={[]}
        />
      </>,
    );
    expect(markup).not.toContain("<fieldset");
    expect(markup).not.toContain("<legend");
    expect(markup).toContain('aria-label="Storage provider"');
    expect(markup).toContain('aria-label="Deployment provider"');
    expect(markup).toContain("Connect to Vercel");
  });

  it("renders connection controls without duplicating server-owned section shells", () => {
    const markup = renderToStaticMarkup(
      <ConnectionsSection
        bare
        connected={[]}
        onAdd={ignoreChange}
        onCustomize={ignoreChange}
        onRemove={ignoreChange}
        onSearchChange={ignoreChange}
        onShowMore={ignoreChange}
        search=""
        selected={[]}
        showMore={false}
      />,
    );
    expect(markup).not.toContain("<fieldset");
    expect(markup).not.toContain("<legend");
    expect(markup).toContain("Search connections");
    expect(markup).toContain('aria-label="Add QuickBooks"');
  });
});
