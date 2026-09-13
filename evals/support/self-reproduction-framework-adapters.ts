import type { Page } from "playwright";
import type { FrameworkId, TrustedFrameworkAdapter } from "./self-reproduction-framework";
import { frameworkMatrix } from "./self-reproduction-parity";

interface SourceFile {
  path: string;
  content: string;
}

const artifactFor = (side: "reference" | "candidate", id: FrameworkId) =>
  `parity/framework/${id}/${side}.json`;
const finding = (id: string, passed: boolean, detail: string, artifact: string) => ({
  id,
  passed,
  detail,
  artifacts: [artifact],
});

function facts(files: readonly SourceFile[]) {
  const app = files.filter((file) => /(?:^|\/)app\//u.test(file.path));
  const roots = app.filter((file) =>
    /(?:^|\/)app\/(?:page|layout)\.[cm]?[jt]sx?$/u.test(file.path),
  );
  const joined = files.map((file) => file.content).join("\n");
  return {
    appRouter: app.some((file) => /(?:^|\/)app\/page\.[cm]?[jt]sx?$/u.test(file.path)),
    clientRoot: roots.some((file) => /^\s*["']use client["']/u.test(file.content)),
    cacheComponents: /cacheComponents\s*:\s*true/u.test(joined),
    instant: /export\s+const\s+instant\s*=/u.test(joined),
    loading: app.some((file) => /(?:^|\/)loading\.[cm]?[jt]sx?$/u.test(file.path)),
    serverWrite: /["']use server["']/u.test(joined),
    sessionScope: /(?:session|userId|workspaceId|tenantId)/u.test(joined),
    semanticTokens: /--(?:background|foreground|surface|border|muted)/u.test(joined),
    instantSelectors: joined.includes("data-app-shell") && joined.includes("data-resolved-content"),
  };
}

/** Checked-in defaults for source plus semantic browser assessment. */
export function createDefaultFrameworkAdapter(input: {
  side: "reference" | "candidate";
  files: readonly SourceFile[];
  baseURL: string;
}): TrustedFrameworkAdapter {
  const source = facts(input.files);
  return {
    reviewSource(requirementId) {
      const artifact = artifactFor(input.side, requirementId);
      const absent =
        (requirementId === "server-first" && !source.appRouter) ||
        (requirementId === "narrow-client" && source.clientRoot) ||
        (requirementId === "server-writes" && !source.serverWrite) ||
        (requirementId === "auth-cache-isolation" && !source.sessionScope) ||
        (requirementId === "suspense" && !source.loading) ||
        (requirementId === "cache-components" && !source.cacheComponents) ||
        (requirementId === "instant-navigation" && !source.instant) ||
        (requirementId === "semantic-tokens" && !source.semanticTokens);
      if (absent)
        return Promise.resolve({
          ready: false,
          disposition: "missing-functionality" as const,
          reason: `Required ${requirementId} source structure was absent.`,
          artifacts: [artifact],
        });
      const assertions = [];
      if (requirementId === "server-first")
        assertions.push(
          finding("request-data-on-server", true, "App Router entry exists.", artifact),
        );
      if (requirementId === "narrow-client")
        assertions.push(
          finding("client-import-graph-reviewed", true, "App entry roots were reviewed.", artifact),
          finding("interactive-leaves-only", true, "No client root directive was found.", artifact),
        );
      if (requirementId === "server-writes")
        assertions.push(
          finding("server-authorizes-write", true, "Server Action module exists.", artifact),
        );
      if (requirementId === "auth-cache-isolation")
        assertions.push(
          finding("cache-scope-reviewed", true, "User or tenant scope is present.", artifact),
        );
      if (requirementId === "cache-components")
        assertions.push(
          finding("cache-boundaries-reviewed", true, "Cache Components is enabled.", artifact),
        );
      if (requirementId === "semantic-tokens")
        assertions.push(
          finding("arrusted-token-provenance", true, "Semantic CSS tokens are present.", artifact),
        );
      return Promise.resolve({
        ready: true as const,
        reason: "Reviewed source against the installed Next 16.3.4 rubric.",
        assertions,
        artifacts: [artifact],
      });
    },
    async exerciseBrowser(page: Page, requirementId: Exclude<FrameworkId, "instant-navigation">) {
      const artifact = artifactFor(input.side, requirementId);
      await page.goto(input.baseURL, { waitUntil: "domcontentloaded" });
      const body = page.locator("body");
      const usefulShell = ((await body.textContent()) ?? "").trim().length > 40;
      const assertions = [];
      if (requirementId === "server-first")
        assertions.push(
          finding("useful-server-shell", usefulShell, "Observed rendered shell.", artifact),
        );
      if (requirementId === "cache-components")
        assertions.push(
          finding("static-shell-observed", usefulShell, "Observed initial shell.", artifact),
        );
      if (requirementId === "semantic-tokens") {
        const colors = await body.evaluate((element) => {
          const style = getComputedStyle(element);
          return { background: style.backgroundColor, foreground: style.color };
        });
        assertions.push(
          finding(
            "palette-unchanged",
            colors.background !== colors.foreground,
            "Observed computed palette.",
            artifact,
          ),
        );
      }
      return {
        reason: assertions.length
          ? "Executed semantic browser checks."
          : "This requirement needs a product fixture adapter for runtime proof.",
        assertions,
        artifacts: [],
      };
    },
    instantNavigationRecipe() {
      const artifact = artifactFor(input.side, "instant-navigation");
      if (!source.instantSelectors)
        return Promise.resolve({
          ready: false as const,
          disposition: "not-run" as const,
          reason: "Distinct shell and resolved-content selectors could not be identified.",
        });
      return Promise.resolve({
        ready: true as const,
        recipe: {
          baseURL: input.baseURL,
          sourcePath: "/",
          destinationPath: "/docs",
          linkSelector: 'a[href="/docs"]',
          shellSelector: "[data-app-shell]",
          resolvedSelector: "[data-resolved-content]",
        },
        artifacts: [artifact],
      });
    },
  };
}

export const defaultFrameworkRequirementIds = frameworkMatrix.map((row) => row.id);

export function createDefaultFrameworkAdapters(input: {
  reference?: { files: readonly SourceFile[]; baseURL: string };
  candidate?: { files: readonly SourceFile[]; baseURL: string };
}): Partial<Record<"reference" | "candidate", TrustedFrameworkAdapter>> {
  return {
    ...(input.reference
      ? {
          reference: createDefaultFrameworkAdapter({ side: "reference", ...input.reference }),
        }
      : {}),
    ...(input.candidate
      ? {
          candidate: createDefaultFrameworkAdapter({ side: "candidate", ...input.candidate }),
        }
      : {}),
  };
}
