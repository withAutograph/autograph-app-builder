/* oxlint-disable eslint/no-await-in-loop -- source traversal preserves deterministic filesystem order. */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

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

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function readSource(root: string, current = root): Promise<SourceFile[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const sourceFiles = await Promise.all(
    entries.map(async (entry): Promise<SourceFile[]> => {
      if (ignored.has(entry.name) || entry.name.startsWith(".")) {
        return [];
      }
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        return readSource(root, filePath);
      }
      if (!entry.isFile() || !/\.(?:[cm]?tsx?|css|mdx?)$/u.test(entry.name)) {
        return [];
      }
      return [{ content: await readFile(filePath, "utf-8"), path: path.relative(root, filePath) }];
    }),
  );
  return sourceFiles.flat();
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function any(files: SourceFile[], expression: RegExp) {
  return files.some((file) => expression.test(file.content));
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function count(files: SourceFile[], expression: RegExp) {
  return files.reduce((total, file) => total + (file.content.match(expression)?.length ?? 0), 0);
}

const codeExtensions = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
] as const;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function clientImportGraph(files: SourceFile[]) {
  const byPath = new Map(files.map((file) => [file.path.replaceAll("\\", "/"), file]));
  const resolveImport = (from: string, specifier: string) => {
    if (!specifier.startsWith(".") && !specifier.startsWith("@/")) {
      return;
    }
    const base = specifier.startsWith("@/")
      ? specifier.slice(2)
      : path.normalize(path.join(path.dirname(from), specifier)).replaceAll("\\", "/");
    for (const prefix of specifier.startsWith("@/") ? [base, `src/${base}`] : [base]) {
      for (const extension of codeExtensions) {
        const candidate = `${prefix}${extension}`;
        if (byPath.has(candidate)) {
          return candidate;
        }
      }
    }
  };
  const dependencies = new Map<string, string[]>();
  for (const file of files) {
    const imports = [
      ...file.content.matchAll(
        /(?:import(?:[\s\S]*?from\s*)?|export[\s\S]*?from\s*)["'](?<path>[^"']+)["']/gu,
      ),
    ]
      .map((match) => resolveImport(file.path, match.groups?.path ?? ""))
      .filter((dependencyPath): dependencyPath is string => dependencyPath !== undefined);
    dependencies.set(file.path, imports);
  }
  const routeRoots = files
    .filter((file) =>
      /(?:^|\/)app\/(?:.*\/)?(?:page|layout|template)\.[cm]?[jt]sx?$/u.test(file.path),
    )
    .map((file) => file.path);
  const clientRouteRoots = routeRoots.filter((routePath) =>
    /^\s*["']use client["']/mu.test(byPath.get(routePath)?.content ?? ""),
  );
  const boundaries = new Set<string>();
  for (const root of routeRoots) {
    const visited = new Set<string>();
    const visit = (filePath: string) => {
      if (visited.has(filePath)) {
        return;
      }
      visited.add(filePath);
      if (/^\s*["']use client["']/mu.test(byPath.get(filePath)?.content ?? "")) {
        boundaries.add(filePath);
        return;
      }
      for (const dependency of dependencies.get(filePath) ?? []) {
        visit(dependency);
      }
    };
    visit(root);
  }
  return { clientBoundaryPaths: [...boundaries].toSorted(), clientRouteRoots };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
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
  const clientGraph = clientImportGraph(codeFiles);
  return {
    appRouter,
    broadClientRoot: clientGraph.clientRouteRoots.length > 0,
    cacheComponents: /cacheComponents\s*:\s*true/u.test(nextConfig),
    clientBoundaryPaths: clientGraph.clientBoundaryPaths,
    clientRoots,
    clientRouteRoots: clientGraph.clientRouteRoots,
    deprecatedPagesRouter: any(
      codeFiles,
      /from\s*["']next\/router["']|getServerSideProps|getStaticProps/gu,
    ),
    loadingRoutes: codeFiles.filter((file) => /(?:^|\/)loading\.tsx$/u.test(file.path)).length,
    partialPrefetching: /partialPrefetching\s*:\s*true/u.test(nextConfig),
    serverActions,
    suspenseBoundaries: count(codeFiles, /<Suspense\b/gu),
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
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
    evidence: candidateAvailable
      ? [
          `Candidate source scan: ${has(expression) ? "matching implementation found" : "no matching implementation found"}.`,
          ...(workflowEvidence?.[id]?.evidence ? [workflowEvidence[id].evidence] : []),
        ]
      : ["Candidate generation output was unavailable."],
    expected,
    id,
    likelyLayer: "Generated application",
    recommendation:
      "Exercise this workflow in the candidate runtime and retain the result in workflow-results.json.",
    status: sourceStatus(id, expression),
    title,
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

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
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
    evidence: [evidence],
    expected: "Next.js 16.3 app-like implementation practice.",
    id: `${side}-${id}`,
    likelyLayer: side === "reference" ? "Handwritten reference" : "Generated application",
    recommendation,
    status,
    title,
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

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
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
