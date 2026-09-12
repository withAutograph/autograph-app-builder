import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

export type RequirementStatus = "passed" | "failed" | "blocked" | "unassessed";

export interface Requirement {
  id: string;
  title: string;
  expected: string;
  evidence: string[];
  status: RequirementStatus;
  likelyLayer: string;
  recommendation: string;
}

export interface SourceFile {
  path: string;
  content: string;
}
export type WorkflowEvidence = Record<string, { status: RequirementStatus; evidence?: string }>;

const ignored = new Set([".git", ".next", ".artifacts", "node_modules", "coverage"]);

export async function readSource(root: string, current = root): Promise<SourceFile[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const sourceFiles = await Promise.all(
    entries.map(async (entry): Promise<SourceFile[]> => {
      if (ignored.has(entry.name) || entry.name.startsWith(".")) return [];
      const path = join(current, entry.name);
      if (entry.isDirectory()) return readSource(root, path);
      if (!entry.isFile() || !/\.(?:[cm]?tsx?|css|mdx?)$/u.test(entry.name)) return [];
      return [{ path: relative(root, path), content: await readFile(path, "utf-8") }];
    }),
  );
  return sourceFiles.flat();
}

function any(files: SourceFile[], expression: RegExp) {
  return files.some((file) => expression.test(file.content));
}

function count(files: SourceFile[], expression: RegExp) {
  return files.reduce((total, file) => total + (file.content.match(expression)?.length ?? 0), 0);
}

export function auditFramework(files: SourceFile[]) {
  // Generated skill payloads can quote deprecated APIs as guidance. They are
  // not application implementation evidence.
  const codeFiles = files.filter(
    (file) =>
      !/\.generated\.[cm]?tsx?$/u.test(file.path) && !/^(?:evals|scripts)\//u.test(file.path),
  );
  const nextConfig = codeFiles.find((file) => file.path.startsWith("next.config."))?.content ?? "";
  const appRouter = codeFiles.some((file) => /^(?:src\/)?app\//u.test(file.path));
  const clientRoots = codeFiles.filter((file) =>
    /^\s*["']use client["']/mu.test(file.content),
  ).length;
  const serverActions = codeFiles.filter((file) =>
    /^\s*["']use server["']/mu.test(file.content),
  ).length;
  return {
    appRouter,
    cacheComponents: /cacheComponents\s*:\s*true/u.test(nextConfig),
    partialPrefetching: /partialPrefetching\s*:\s*true/u.test(nextConfig),
    suspenseBoundaries: count(codeFiles, /<Suspense\b/gu),
    loadingRoutes: codeFiles.filter((file) => /(?:^|\/)loading\.tsx$/u.test(file.path)).length,
    clientRoots,
    serverActions,
    deprecatedPagesRouter: any(
      codeFiles,
      /from\s*["']next\/router["']|getServerSideProps|getStaticProps/gu,
    ),
    broadClientRoot: codeFiles.some(
      (file) =>
        /^\s*["']use client["']/mu.test(file.content) &&
        /<main\b|<html\b|<body\b/u.test(file.content),
    ),
  };
}

export function buildRequirements(
  candidate: SourceFile[] | undefined,
  workflowEvidence?: WorkflowEvidence,
): Requirement[] {
  const candidateAvailable = candidate !== undefined;
  const text = candidate?.map((file) => file.content).join("\n") ?? "";
  const has = (expression: RegExp) => expression.test(text);
  const sourceStatus = (id: string, expression: RegExp): RequirementStatus =>
    candidateAvailable
      ? (workflowEvidence?.[id]?.status ?? (has(expression) ? "unassessed" : "failed"))
      : "blocked";
  const workflow = (id: string, title: string, expression: RegExp, expected: string) => ({
    id,
    title,
    expected,
    evidence: candidateAvailable
      ? [
          `Candidate source scan: ${has(expression) ? "matching implementation found" : "no matching implementation found"}.`,
          ...(workflowEvidence?.[id]?.evidence ? [workflowEvidence[id].evidence] : []),
        ]
      : ["Candidate generation output was unavailable."],
    status: sourceStatus(id, expression),
    likelyLayer: "Generated application",
    recommendation:
      "Exercise this workflow in the candidate runtime and retain the result in workflow-results.json.",
  });
  return [
    workflow(
      "anonymous-entry",
      "Anonymous entry",
      /What should this app do\?|Build an app/iu,
      "An anonymous user can enter a brief and continue.",
    ),
    workflow(
      "durable-draft",
      "Durable draft",
      /draft|autosave|persist/iu,
      "The active draft survives reload and provider return.",
    ),
    workflow(
      "provider-return",
      "Provider return",
      /github|vercel|provider/iu,
      "Provider success and failure returns preserve the active draft.",
    ),
    workflow(
      "independent-creation",
      "Independent child-app creation",
      /create[\s\S]*app|generated[\s\S]*app|preview/iu,
      "The replica creates one child app without calling the reference Builder.",
    ),
    workflow(
      "recovery",
      "Cancellation and recovery",
      /cancel|retry|recover|resume/iu,
      "A user can cancel, retry, and resume an interrupted creation.",
    ),
    workflow(
      "documentation",
      "Public documentation",
      /docs|documentation/iu,
      "A new user can read a public documentation area.",
    ),
  ];
}

export function frameworkRequirements(
  audit: ReturnType<typeof auditFramework>,
  side: "reference" | "candidate",
) {
  const base = (
    id: string,
    title: string,
    status: RequirementStatus,
    evidence: string,
    recommendation: string,
  ): Requirement => ({
    id: `${side}-${id}`,
    title,
    expected: "Next.js 16.3 app-like implementation practice.",
    status,
    evidence: [evidence],
    likelyLayer: side === "reference" ? "Handwritten reference" : "Generated application",
    recommendation,
  });
  return [
    base(
      "app-router",
      "App Router",
      audit.appRouter ? "passed" : "failed",
      `App Router tree: ${audit.appRouter}.`,
      "Use an App Router app directory.",
    ),
    base(
      "cache-components",
      "Cache Components",
      audit.cacheComponents ? "passed" : "failed",
      `cacheComponents: ${audit.cacheComponents}.`,
      "Enable Cache Components where the app supports it.",
    ),
    base(
      "partial-prefetching",
      "Partial prefetching",
      audit.partialPrefetching ? "passed" : "failed",
      `partialPrefetching: ${audit.partialPrefetching}.`,
      "Enable partial prefetching and validate useful links.",
    ),
    base(
      "server-writes",
      "Server-owned writes",
      audit.serverActions > 0 ? "passed" : "failed",
      `Server Action modules: ${audit.serverActions}.`,
      "Use Server Actions or route handlers for durable writes.",
    ),
    base(
      "loading-boundaries",
      "Loading and Suspense boundaries",
      audit.loadingRoutes + audit.suspenseBoundaries > 0 ? "passed" : "failed",
      `loading routes: ${audit.loadingRoutes}; Suspense boundaries: ${audit.suspenseBoundaries}.`,
      "Add useful loading UI and narrow Suspense boundaries.",
    ),
    base(
      "pages-router",
      "No Pages Router regression",
      audit.deprecatedPagesRouter ? "failed" : "passed",
      `Deprecated Pages Router usage: ${audit.deprecatedPagesRouter}.`,
      "Use App Router APIs.",
    ),
    base(
      "narrow-client",
      "Narrow client boundaries",
      audit.broadClientRoot ? "failed" : "passed",
      `Client roots: ${audit.clientRoots}; broad client root: ${audit.broadClientRoot}.`,
      "Move request data and page shells back to Server Components.",
    ),
    base(
      "instant-navigation",
      "Observed instant navigation",
      "unassessed",
      "Requires a production-like candidate runtime and @next/playwright instant() assertions; static configuration is deliberately insufficient.",
      "Run the generated app's focused instant-navigation test and attach its result.",
    ),
  ];
}

export function prioritizedGaps(requirements: Requirement[]) {
  return requirements
    .filter((requirement) => requirement.status === "failed" || requirement.status === "blocked")
    .map((requirement) => ({
      priority:
        requirement.id.includes("independent") || requirement.id.includes("durable")
          ? "high"
          : "medium",
      ...requirement,
      confirmed: requirement.status === "failed",
    }));
}
