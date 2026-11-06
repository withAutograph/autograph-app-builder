import type { TrustedFrameworkAdapter } from "./self-reproduction-framework";
import { frameworkMatrix } from "./self-reproduction-parity";

interface SourceFile {
  path: string;
  content: string;
}

/** Structural hints guide a reviewer; they do not establish framework behavior. */
const structuralHints = (files: readonly SourceFile[]) => {
  const hints: Record<
    "appRouterEntries" | "clientDirectiveFiles" | "serverDirectiveFiles" | "suspenseCandidateFiles",
    string[]
  > = {
    appRouterEntries: [],
    clientDirectiveFiles: [],
    serverDirectiveFiles: [],
    suspenseCandidateFiles: [],
  };
  for (const file of files) {
    if (/(?:^|\/)app\/(?:page|layout)\.[cm]?[jt]sx?$/u.test(file.path)) {
      hints.appRouterEntries.push(file.path);
    }
    if (/^\s*["']use client["']/u.test(file.content)) {
      hints.clientDirectiveFiles.push(file.path);
    }
    if (/["']use server["']/u.test(file.content)) {
      hints.serverDirectiveFiles.push(file.path);
    }
    if (/Suspense/u.test(file.content) || /(?:^|\/)loading\.[cm]?[jt]sx?$/u.test(file.path)) {
      hints.suspenseCandidateFiles.push(file.path);
    }
  }
  return hints;
};

/**
 * Default discovery reports source hints only. Evaluator-owned reviews and
 * runtime fixtures must supply assertions; filenames and rendered body text
 * cannot prove authorization, server rendering, cache scope, or token provenance.
 */
export const createDefaultFrameworkAdapter = (input: {
  side: "reference" | "candidate";
  files: readonly SourceFile[];
  baseURL: string;
  sourceReview?: (
    requirementId: (typeof frameworkMatrix)[number]["id"],
  ) => ReturnType<TrustedFrameworkAdapter["reviewSource"]>;
  browserFixture?: TrustedFrameworkAdapter["exerciseBrowser"];
  navigationFixture?: TrustedFrameworkAdapter["instantNavigationRecipe"];
}): TrustedFrameworkAdapter => {
  const hints = structuralHints(input.files);
  return {
    exerciseBrowser:
      input.browserFixture ??
      (() => ({
        artifacts: [],
        assertions: [],
        disposition: "not-run",
        reason: "No evaluator-owned behavioral fixture is bound for this framework requirement.",
      })),
    instantNavigationRecipe:
      input.navigationFixture ??
      (() => ({
        disposition: "not-run",
        ready: false,
        reason:
          "No evaluator-owned instant-navigation route and resolved-content fixture is bound.",
      })),
    reviewSource:
      input.sourceReview ??
      (() => ({
        artifacts: [],
        disposition: "not-run",
        ready: false,
        reason: `No evaluator-owned source review is bound. Structural hints (not assertion evidence): ${JSON.stringify(hints)}`,
      })),
  };
};

export const defaultFrameworkRequirementIds = frameworkMatrix.map((row) => row.id);

export const createDefaultFrameworkAdapters = (input: {
  reference?: { files: readonly SourceFile[]; baseURL: string };
  candidate?: { files: readonly SourceFile[]; baseURL: string };
}): Partial<Record<"reference" | "candidate", TrustedFrameworkAdapter>> => {
  const adapters: Partial<Record<"reference" | "candidate", TrustedFrameworkAdapter>> = {};
  if (input.reference) {
    adapters.reference = createDefaultFrameworkAdapter({ side: "reference", ...input.reference });
  }
  if (input.candidate) {
    adapters.candidate = createDefaultFrameworkAdapter({ side: "candidate", ...input.candidate });
  }
  return adapters;
};
