import type { TargetProposal } from "../repository/target-planning";
import { describedBrowserEntryPath } from "../repository/browser-entry-path";

/** Authoring context only; the saved plan owns the declared public routes. */
export const implementationRouteContext = (plan?: TargetProposal["plan"]) => {
  if (plan === undefined) {
    return {};
  }
  const routes = [...plan.topology.routes];
  const entryPath = describedBrowserEntryPath({ routes });
  return {
    implementationRouting: {
      routes,
      entryPath,
      instruction:
        entryPath === null
          ? "Serve each registered pathname in the app router and use those paths for navigation and redirects."
          : `The gateway forwards the registered pathname unchanged. Serve the primary Next App Router page at ${entryPath} in the selected workspace. Put the page under the matching app route segment or its equivalent route group. Use that same entry path in navigation, redirects, and the private preview. Preserve the generated workspace dependencies when authoring package.json, including the CUE runtime dependency for a schema-backed app.`,
    },
  };
};
