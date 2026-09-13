import type { TrustedFrameworkAdapter } from "./self-reproduction-framework";
import { frameworkMatrix } from "./self-reproduction-parity";

interface SourceFile {
  path: string;
  content: string;
}

/** Structural hints guide a reviewer; they do not establish framework behavior. */
function structuralHints(files: readonly SourceFile[]) {
  return {
    appRouterEntries: files
      .filter((file) => /(?:^|\/)app\/(?:page|layout)\.[cm]?[jt]sx?$/u.test(file.path))
      .map((file) => file.path),
    clientDirectiveFiles: files
      .filter((file) => /^\s*["']use client["']/u.test(file.content))
      .map((file) => file.path),
    serverDirectiveFiles: files
      .filter((file) => /["']use server["']/u.test(file.content))
      .map((file) => file.path),
    suspenseCandidateFiles: files
      .filter(
        (file) =>
          /Suspense/u.test(file.content) || /(?:^|\/)loading\.[cm]?[jt]sx?$/u.test(file.path),
      )
      .map((file) => file.path),
  };
}

/**
 * Default discovery reports source hints only. Evaluator-owned reviews and
 * runtime fixtures must supply assertions; filenames and rendered body text
 * cannot prove authorization, server rendering, cache scope, or token provenance.
 */
export function createDefaultFrameworkAdapter(input: {
  side: "reference" | "candidate";
  files: readonly SourceFile[];
  baseURL: string;
  sourceReview?: TrustedFrameworkAdapter["reviewSource"];
  browserFixture?: TrustedFrameworkAdapter["exerciseBrowser"];
  navigationFixture?: TrustedFrameworkAdapter["instantNavigationRecipe"];
}): TrustedFrameworkAdapter {
  const hints = structuralHints(input.files);
  return {
    reviewSource:
      input.sourceReview ??
      (() =>
        Promise.resolve({
          ready: false,
          disposition: "not-run",
          reason: `No evaluator-owned source review is bound. Structural hints (not assertion evidence): ${JSON.stringify(hints)}`,
          artifacts: [],
        })),
    exerciseBrowser:
      input.browserFixture ??
      (() =>
        Promise.resolve({
          disposition: "not-run",
          reason: "No evaluator-owned behavioral fixture is bound for this framework requirement.",
          assertions: [],
          artifacts: [],
        })),
    instantNavigationRecipe:
      input.navigationFixture ??
      (() =>
        Promise.resolve({
          ready: false,
          disposition: "not-run",
          reason:
            "No evaluator-owned instant-navigation route and resolved-content fixture is bound.",
        })),
  };
}

export const defaultFrameworkRequirementIds = frameworkMatrix.map((row) => row.id);

export function createDefaultFrameworkAdapters(input: {
  reference?: { files: readonly SourceFile[]; baseURL: string };
  candidate?: { files: readonly SourceFile[]; baseURL: string };
}): Partial<Record<"reference" | "candidate", TrustedFrameworkAdapter>> {
  return {
    ...(input.reference
      ? { reference: createDefaultFrameworkAdapter({ side: "reference", ...input.reference }) }
      : {}),
    ...(input.candidate
      ? { candidate: createDefaultFrameworkAdapter({ side: "candidate", ...input.candidate }) }
      : {}),
  };
}
