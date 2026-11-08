import { z } from "zod";

const sha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const id = z.number().int().positive();
const branch = z.string().min(1);
const timestamp = z.iso.datetime({ offset: true });

export interface GitHubPrDeliveryRef {
  repositoryId: string;
  owner: string;
  name: string;
  pullRequestNumber: number;
  headSha: string;
  baseBranch: string;
  readyAuthorization?: "contents-write" | "recover-first-ready";
}

export interface GitHubPrDeliveryObservation {
  state: "open" | "closed" | "merged";
  draft: boolean;
  headSha: string;
  baseBranch: string;
  mergeCommitSha?: string;
  readyAt?: string;
  checkRunId?: number;
  checks: "pending" | "failed" | "passed";
}

export interface GitHubPrDeliveryProvider {
  inspect: (ref: GitHubPrDeliveryRef) => Promise<GitHubPrDeliveryObservation>;
  markReady: (
    ref: GitHubPrDeliveryRef,
    signal?: AbortSignal,
  ) => Promise<GitHubPrDeliveryObservation>;
  merge: (
    ref: GitHubPrDeliveryRef,
    readyAt: string,
    signal?: AbortSignal,
  ) => Promise<GitHubPrDeliveryObservation>;
}

export class GitHubPrEffectRejectedError extends Error {
  readonly code: "provider-rejected" | "cancelled";

  constructor(code: GitHubPrEffectRejectedError["code"]) {
    super(code === "cancelled" ? "github-delivery-cancelled" : "github-delivery-provider-rejected");
    this.name = "GitHubPrEffectRejectedError";
    this.code = code;
  }
}

const assertMutationActive = (signal?: AbortSignal) => {
  if (signal?.aborted === true) {
    throw new GitHubPrEffectRejectedError("cancelled");
  }
};

type Request = (input: {
  method?: "GET" | "POST" | "PUT";
  path: string;
  body?: unknown;
  effect?: "ready" | "merge";
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- Raw provider payload is parsed at each endpoint boundary.
}) => Promise<unknown>;

const pullSchema = z.object({
  node_id: z.string().min(1),
  number: id,
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  merged: z.boolean(),
  merge_commit_sha: sha.nullable(),
  head: z.object({ sha, ref: branch, repo: z.object({ id }).nullable() }),
  base: z.object({ ref: branch, repo: z.object({ id }) }),
});

const readySchema = z.object({
  data: z.object({
    node: z.object({
      headRefOid: sha,
      baseRefName: branch,
      isDraft: z.boolean(),
      timelineItems: z.object({
        nodes: z.array(z.object({ createdAt: timestamp })),
      }),
      baseChanges: z.object({
        nodes: z.array(z.object({ createdAt: timestamp })),
      }),
    }),
  }),
});

const runSchema = z.object({
  id,
  event: z.string(),
  head_sha: sha,
  run_attempt: id,
  head_branch: branch,
  head_repository: z.object({ id }).nullable(),
  path: z.string(),
  created_at: timestamp,
  status: z.string(),
  conclusion: z.string().nullable(),
  pull_requests: z.array(
    z.object({
      number: id,
      base: z.object({ ref: branch, repo: z.object({ id }) }),
      head: z.object({ repo: z.object({ id }) }),
    }),
  ),
});

const jobSchema = z.object({
  run_id: id,
  run_attempt: id,
  head_sha: sha,
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
});

const readyQuery = `query ReadReadyCycle($id: ID!) {
  node(id: $id) {
    ... on PullRequest {
      headRefOid
      baseRefName
      isDraft
      timelineItems(last: 1, itemTypes: [READY_FOR_REVIEW_EVENT]) {
        nodes { ... on ReadyForReviewEvent { createdAt } }
      }
      baseChanges: timelineItems(last: 1, itemTypes: [BASE_REF_CHANGED_EVENT]) {
        nodes { ... on BaseRefChangedEvent { createdAt } }
      }
    }
  }
}`;

const readyMutation = `mutation ReadyForReview($id: ID!) {
  markPullRequestReadyForReview(input: {pullRequestId: $id}) {
    pullRequest { id isDraft }
  }
}`;

type CheckObservation = Pick<GitHubPrDeliveryObservation, "checks" | "readyAt" | "checkRunId">;

const assertExpectedHead = (ref: GitHubPrDeliveryRef, result: GitHubPrDeliveryObservation) => {
  if (result.headSha !== ref.headSha || result.baseBranch !== ref.baseBranch) {
    throw new Error("github-delivery-pull-request-changed");
  }
};

const pullWindowSchema = z.object({
  number: id,
  created_at: timestamp,
  closed_at: timestamp.nullable(),
  head: z.object({ ref: branch, repo: z.object({ id }).nullable() }),
});

const pullWindows = async (request: Request, prefix: string, owner: string, headBranch: string) => {
  const windows: z.infer<typeof pullWindowSchema>[] = [];
  for (let page = 1; ; page += 1) {
    const head = encodeURIComponent(`${owner}:${headBranch}`);
    const pulls = z.array(pullWindowSchema).parse(
      // oxlint-disable-next-line eslint/no-await-in-loop -- GitHub inventory is paginated.
      await request({
        path: `${prefix}/pulls?state=all&head=${head}&per_page=100&page=${page}`,
      }),
    );
    windows.push(...pulls);
    if (pulls.length < 100) {
      return windows;
    }
  }
};

const runMatchesPull = (
  run: z.infer<typeof runSchema>,
  pull: z.infer<typeof pullSchema>,
  windows: readonly z.infer<typeof pullWindowSchema>[],
) => {
  if (run.pull_requests.length > 0) {
    return run.pull_requests.some(
      (associated) =>
        associated.number === pull.number &&
        associated.base.ref === pull.base.ref &&
        associated.base.repo.id === pull.base.repo.id &&
        associated.head.repo.id === pull.base.repo.id,
    );
  }
  // GitHub can omit pull_requests even for pull_request runs. The provider's
  // inventory must identify this exact PR as the only open PR from the run's
  // same-repository branch at the time the run was created.
  const createdAt = Date.parse(run.created_at);
  const active = windows.filter((candidate) => {
    const fromSameBranch =
      candidate.head.ref === pull.head.ref && candidate.head.repo?.id === pull.base.repo.id;
    const openAtRun =
      Date.parse(candidate.created_at) <= createdAt &&
      (candidate.closed_at === null || Date.parse(candidate.closed_at) >= createdAt);
    return fromSameBranch && openAtRun;
  });
  return active.length === 1 && active[0]?.number === pull.number;
};

const readReadyHistory = async (request: Request, pull: z.infer<typeof pullSchema>) => {
  const response = await request({
    method: "POST",
    path: "/graphql",
    body: { query: readyQuery, variables: { id: pull.node_id } },
  });
  return readySchema.parse(response).data.node;
};

const readReadyCycle = async (request: Request, pull: z.infer<typeof pullSchema>) => {
  const cycle = await readReadyHistory(request, pull);
  const readyAt = cycle.timelineItems.nodes[0]?.createdAt;
  if (
    cycle.isDraft ||
    cycle.headRefOid !== pull.head.sha ||
    cycle.baseRefName !== pull.base.ref ||
    readyAt === undefined
  ) {
    return null;
  }
  const baseChangedAt = cycle.baseChanges.nodes[0]?.createdAt ?? readyAt;
  return { readyAt, earliestRunAt: Math.max(Date.parse(readyAt), Date.parse(baseChangedAt)) };
};

const checkJobs = async (request: Request, prefix: string, runId: number) => {
  const checks: z.infer<typeof jobSchema>[] = [];
  for (let page = 1; ; page += 1) {
    const { jobs } = z.object({ jobs: z.array(jobSchema) }).parse(
      // oxlint-disable-next-line eslint/no-await-in-loop -- GitHub jobs are paginated.
      await request({
        path: `${prefix}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`,
      }),
    );
    checks.push(...jobs.filter((job) => job.name === "Check"));
    if (jobs.length < 100) {
      return checks;
    }
  }
};

const checkReadyRun = async (
  request: Request,
  prefix: string,
  pull: z.infer<typeof pullSchema>,
  owner: string,
  { readyAt, earliestRunAt }: { readyAt: string; earliestRunAt: number },
): Promise<CheckObservation> => {
  const runs = z.object({ workflow_runs: z.array(runSchema) }).parse(
    await request({
      path: `${prefix}/actions/workflows/check.yml/runs?event=pull_request&head_sha=${pull.head.sha}&per_page=100`,
    }),
  ).workflow_runs;
  const candidates = runs.filter((candidate) => {
    const exactHead =
      candidate.head_sha === pull.head.sha &&
      candidate.head_branch === pull.head.ref &&
      candidate.head_repository?.id === pull.base.repo.id;
    const readyWorkflow =
      candidate.event === "pull_request" &&
      candidate.path === ".github/workflows/check.yml" &&
      Date.parse(candidate.created_at) >= earliestRunAt;
    return exactHead && readyWorkflow;
  });
  const windows = candidates.some((run) => run.pull_requests.length === 0)
    ? await pullWindows(request, prefix, owner, pull.head.ref)
    : [];
  // GitHub lists newest runs first. An unresolved association for the newest
  // plausible run is pending instead of qualifying an older successful run.
  const run = candidates[0];
  if (run === undefined || !runMatchesPull(run, pull, windows)) {
    return { checks: "pending", readyAt };
  }
  const jobs = await checkJobs(request, prefix, run.id);
  if (
    jobs.some(
      (job) =>
        job.run_id !== run.id ||
        job.run_attempt !== run.run_attempt ||
        job.head_sha !== run.head_sha,
    )
  ) {
    return { checks: "pending", readyAt, checkRunId: run.id };
  }
  if (jobs.length !== 1 || jobs[0]?.status !== "completed") {
    return {
      checks: run.status === "completed" ? "failed" : "pending",
      readyAt,
      checkRunId: run.id,
    };
  }
  return {
    checks: jobs[0].conclusion === "success" ? "passed" : "failed",
    readyAt,
    checkRunId: run.id,
  };
};

export const createGitHubPrDeliveryProvider = (
  scopedRequest: (
    ref: GitHubPrDeliveryRef,
    operation: "read" | "ready" | "merge",
  ) => Promise<Request>,
): GitHubPrDeliveryProvider => {
  const observe = async (ref: GitHubPrDeliveryRef, request: Request) => {
    const prefix = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`;
    const pullPath = `${prefix}/pulls/${ref.pullRequestNumber}`;
    const pull = pullSchema.parse(await request({ path: pullPath }));
    if (
      pull.number !== ref.pullRequestNumber ||
      String(pull.base.repo.id) !== ref.repositoryId ||
      pull.head.repo?.id !== pull.base.repo.id
    ) {
      throw new Error("github-delivery-pull-request-identity-changed");
    }
    const state = pull.merged ? "merged" : pull.state;
    const result: GitHubPrDeliveryObservation = {
      state,
      draft: pull.draft,
      headSha: pull.head.sha,
      baseBranch: pull.base.ref,
      checks: "pending",
    };
    if (pull.merged && pull.merge_commit_sha !== null) {
      result.mergeCommitSha = pull.merge_commit_sha;
    }
    if (
      state !== "closed" &&
      !pull.draft &&
      pull.head.sha === ref.headSha &&
      pull.base.ref === ref.baseBranch
    ) {
      const readyCycle = await readReadyCycle(request, pull);
      if (readyCycle !== null) {
        result.readyAt = readyCycle.readyAt;
        if (state === "open") {
          Object.assign(result, await checkReadyRun(request, prefix, pull, ref.owner, readyCycle));
        }
      }
    }
    return { pull, pullPath, result };
  };

  return {
    async inspect(ref) {
      const { result } = await observe(ref, await scopedRequest(ref, "read"));
      return result;
    },
    async markReady(ref, signal) {
      const request = await scopedRequest(ref, "ready");
      const before = await observe(ref, request);
      assertExpectedHead(ref, before.result);
      if (before.result.state !== "open") {
        throw new Error("github-delivery-pull-request-not-open");
      }
      if (!before.result.draft) {
        return before.result;
      }
      if (ref.readyAuthorization === "recover-first-ready") {
        const history = await readReadyHistory(request, before.pull);
        if (
          !history.isDraft ||
          history.headRefOid !== ref.headSha ||
          history.baseRefName !== ref.baseBranch ||
          history.timelineItems.nodes.length > 0
        ) {
          throw new GitHubPrEffectRejectedError("provider-rejected");
        }
      }
      assertMutationActive(signal);
      const payload = await request({
        method: "POST",
        path: "/graphql",
        effect: "ready",
        body: { query: readyMutation, variables: { id: before.pull.node_id } },
      });
      const rejection = z
        .object({
          data: z
            .union([z.null(), z.object({ markPullRequestReadyForReview: z.null() })])
            .optional(),
          errors: z.array(z.object({ type: z.literal("FORBIDDEN") })).min(1),
        })
        .safeParse(payload);
      if (rejection.success) {
        throw new GitHubPrEffectRejectedError("provider-rejected");
      }
      const response = z
        .object({
          data: z.object({
            markPullRequestReadyForReview: z.object({
              pullRequest: z.object({ id: z.string(), isDraft: z.literal(false) }),
            }),
          }),
        })
        .parse(payload);
      if (response.data.markPullRequestReadyForReview.pullRequest.id !== before.pull.node_id) {
        throw new Error("github-delivery-ready-identity-changed");
      }
      const { result: after } = await observe(ref, request);
      assertExpectedHead(ref, after);
      if (after.state !== "open" || after.draft) {
        throw new Error("github-delivery-ready-unverified");
      }
      return after;
    },
    async merge(ref, readyAt, signal) {
      const request = await scopedRequest(ref, "merge");
      const before = await observe(ref, request);
      assertExpectedHead(ref, before.result);
      if (before.result.readyAt !== readyAt) {
        throw new Error("github-delivery-ready-cycle-changed");
      }
      if (before.result.state === "merged" && before.result.mergeCommitSha !== undefined) {
        return before.result;
      }
      if (
        before.result.state !== "open" ||
        before.result.draft ||
        before.result.checks !== "passed"
      ) {
        throw new Error("github-delivery-merge-not-eligible");
      }
      assertMutationActive(signal);
      const merged = z.object({ merged: z.literal(true), sha }).parse(
        await request({
          method: "PUT",
          path: `${before.pullPath}/merge`,
          effect: "merge",
          body: { sha: ref.headSha, merge_method: "squash" },
        }),
      );
      const { result: after } = await observe(ref, request);
      assertExpectedHead(ref, after);
      if (
        after.state !== "merged" ||
        after.mergeCommitSha !== merged.sha ||
        after.readyAt !== readyAt
      ) {
        throw new Error("github-delivery-merge-unverified");
      }
      return after;
    },
  };
};
