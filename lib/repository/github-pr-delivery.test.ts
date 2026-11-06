import { describe, expect, it } from "vitest";

import { createGitHubPrDeliveryProvider } from "./github-pr-delivery";
import type { GitHubPrDeliveryRef } from "./github-pr-delivery";

const head = "a".repeat(40);
const merge = "b".repeat(40);
const readyAt = "2026-11-05T19:00:00Z";
const earlier = "2026-11-05T18:59:59Z";
const ref: GitHubPrDeliveryRef = {
  baseBranch: "main",
  headSha: head,
  name: "app",
  owner: "owner",
  pullRequestNumber: 7,
  repositoryId: "100",
};

const harness = (
  input: {
    draft?: boolean;
    readyDenied?: boolean;
    previousReady?: boolean;
    headSha?: string;
    runCreatedAt?: string;
    checkConclusion?: string;
    extraActivePr?: boolean;
    runAttempt?: number;
    baseChangedAt?: string;
    onInspect?: () => void;
  } = {},
) => {
  let draft = input.draft ?? false;
  let merged = false;
  const effects: unknown[] = [];
  const graphql = (body: string) => {
    if (draft && body.includes("mutation ReadyForReview")) {
      effects.push({ body, path: "/graphql" });
      if (input.readyDenied === true) {
        return {
          data: { markPullRequestReadyForReview: null },
          errors: [{ type: "FORBIDDEN" }],
        };
      }
      draft = false;
      return {
        data: { markPullRequestReadyForReview: { pullRequest: { id: "node", isDraft: false } } },
      };
    }
    return {
      data: {
        node: {
          baseChanges: {
            nodes: input.baseChangedAt === undefined ? [] : [{ createdAt: input.baseChangedAt }],
          },
          baseRefName: "main",
          headRefOid: input.headSha ?? head,
          isDraft: draft,
          timelineItems: {
            nodes: !draft || input.previousReady === true ? [{ createdAt: readyAt }] : [],
          },
        },
      },
    };
  };
  // oxlint-disable-next-line eslint/require-await -- In-memory provider double implements the asynchronous transport.
  const provider = createGitHubPrDeliveryProvider(async () => async ({ path, method, body }) => {
    if (method === "PUT") {
      effects.push({ body, path });
      merged = true;
      return { merged, sha: merge };
    }
    if (path === "/graphql") {
      return graphql(JSON.stringify(body));
    }
    if (path === "/repos/owner/app/pulls/7") {
      input.onInspect?.();
      return {
        base: { ref: "main", repo: { id: 100 } },
        draft,
        head: { ref: "builder", repo: { id: 100 }, sha: input.headSha ?? head },
        merge_commit_sha: merged ? merge : null,
        merged,
        node_id: "node",
        number: 7,
        state: merged ? "closed" : "open",
      };
    }
    if (path.includes("/workflows/check.yml/runs?")) {
      return {
        workflow_runs: [
          {
            conclusion: null,
            created_at: input.runCreatedAt ?? readyAt,
            event: "pull_request",
            head_branch: "builder",
            head_repository: { id: 100 },
            head_sha: head,
            id: 11,
            path: ".github/workflows/check.yml",
            pull_requests: [],
            run_attempt: input.runAttempt ?? 1,
            status: "in_progress",
          },
        ],
      };
    }
    if (path.includes("/pulls?")) {
      const window = {
        closed_at: null,
        created_at: earlier,
        head: { ref: "builder", repo: { id: 100 } },
      };
      return [
        { ...window, number: 7 },
        ...(input.extraActivePr === true ? [{ ...window, number: 8 }] : []),
      ];
    }
    if (path.includes("/runs/11/jobs?")) {
      return {
        jobs: [
          {
            conclusion: input.checkConclusion ?? "success",
            head_sha: head,
            name: "Check",
            run_attempt: 1,
            run_id: 11,
            status: "completed",
          },
          {
            conclusion: null,
            head_sha: head,
            name: "Advisory",
            run_attempt: 1,
            run_id: 11,
            status: "in_progress",
          },
        ],
      };
    }
    throw new Error(`unexpected request ${path}`);
  });
  return { effects, provider };
};

describe("GitHub pull request delivery", () => {
  it("recognizes only the bound PR's current ready-cycle Check and guards the merge by SHA", async () => {
    const { effects, provider } = harness();
    await expect(provider.inspect(ref)).resolves.toMatchObject({
      checkRunId: 11,
      checks: "passed",
    });
    await expect(provider.merge(ref, readyAt)).resolves.toMatchObject({
      mergeCommitSha: merge,
      state: "merged",
    });
    await expect(provider.merge(ref, readyAt)).resolves.toMatchObject({
      mergeCommitSha: merge,
      state: "merged",
    });
    expect(effects).toEqual([
      { body: { merge_method: "squash", sha: head }, path: "/repos/owner/app/pulls/7/merge" },
    ]);
  });

  it.each([
    { runCreatedAt: earlier },
    { checkConclusion: "skipped" },
    { extraActivePr: true },
    { headSha: merge },
    { runAttempt: 2 },
    { baseChangedAt: "2026-11-05T19:00:01Z" },
  ])("does not merge when CI or head binding is stale, skipped, or ambiguous", async (input) => {
    const { effects, provider } = harness(input);
    await expect(provider.merge(ref, readyAt)).rejects.toThrow(/^github-delivery-/u);
    expect(effects).toHaveLength(0);
  });

  it("rejects a merge authorized for an earlier ready cycle", async () => {
    const { effects, provider } = harness();
    await expect(provider.merge(ref, earlier)).rejects.toThrow(
      "github-delivery-ready-cycle-changed",
    );
    expect(effects).toHaveLength(0);
  });

  it.each(["ready", "merge"] as const)(
    "honors cancellation during %s preflight",
    async (effect) => {
      const abort = new AbortController();
      const { effects, provider } = harness({
        draft: effect === "ready",
        onInspect: () => {
          abort.abort();
        },
      });
      const result =
        effect === "ready"
          ? provider.markReady(ref, abort.signal)
          : provider.merge(ref, readyAt, abort.signal);
      await expect(result).rejects.toMatchObject({ code: "cancelled" });
      expect(effects).toHaveLength(0);
    },
  );

  it("marks a bound draft ready once and reads back the result", async () => {
    const { effects, provider } = harness({ draft: true });
    await expect(provider.markReady(ref)).resolves.toMatchObject({ draft: false, state: "open" });
    await expect(provider.markReady(ref)).resolves.toMatchObject({ draft: false, state: "open" });
    expect(effects).toHaveLength(1);
  });
});

it("distinguishes a GraphQL permission rejection from an unconfirmed Ready write", async () => {
  const { provider } = harness({ draft: true, readyDenied: true });
  await expect(provider.markReady(ref)).rejects.toMatchObject({ code: "provider-rejected" });
});

it("recovers a first Ready without reopening an earlier Ready cycle", async () => {
  const recoveryRef = { ...ref, readyAuthorization: "recover-first-ready" as const };
  const fresh = harness({ draft: true });
  await expect(fresh.provider.markReady(recoveryRef)).resolves.toMatchObject({ draft: false });

  const prior = harness({ draft: true, previousReady: true });
  await expect(prior.provider.markReady(recoveryRef)).rejects.toMatchObject({
    code: "provider-rejected",
  });
  expect(prior.effects).toHaveLength(0);
});
