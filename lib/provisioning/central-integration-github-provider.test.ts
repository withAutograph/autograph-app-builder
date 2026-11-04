/* oxlint-disable eslint/require-await -- Deterministic provider and durable checkpoint boundary fixtures. */
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { plan } from "./central-integration-host-test-fixture";
import {
  centralHostOperationRef,
  centralHostPlanDigest,
} from "./central-integration-host-contract";
import type { CentralHostEffectContext } from "./central-integration-host-service";
import { createCentralHostGitHubProvider } from "./central-integration-github-provider";
const fixture = () => {
  let published = false;
  let lostResponse = false;
  let active = true;
  const calls: string[] = [];
  const guard = vi.fn(async () => {
    if (!active) throw new Error("revoked");
  });
  const reference = () => ({
    ref: `refs/heads/${plan.source.operationBranch}`,
    object: { type: "commit", sha: plan.source.reviewedSourceSha },
  });
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(z.string().parse(url)).pathname;
    calls.push(`${init?.method} ${path}`);
    expect(init?.redirect).toBe("error");
    if (path === `/repositories/${plan.source.repositoryId}`)
      return Response.json({ id: plan.source.repositoryId, full_name: "owned/central" });
    if (path === `/repos/owned/central/git/commits/${plan.source.reviewedSourceSha}`)
      return Response.json({ sha: plan.source.reviewedSourceSha });
    if (init?.method === "POST" && path === "/repos/owned/central/git/refs") {
      expect(JSON.parse(z.string().parse(init.body))).toEqual({
        ref: reference().ref,
        sha: plan.source.reviewedSourceSha,
      });
      published = true;
      if (lostResponse) throw new Error("network_unknown");
      return Response.json(reference());
    }
    if (path.startsWith("/repos/owned/central/git/ref/heads/"))
      return published ? Response.json(reference()) : new Response(null, { status: 404 });
    throw new Error("unexpected_provider_request");
  });
  const adapter = createCentralHostGitHubProvider({
    assertCurrent: guard,
    readCredential: async () => ({
      token: "private-token",
      repositoryId: plan.source.repositoryId,
      installationId: plan.source.installationId,
    }),
    fetch: fetcher,
  });
  const unused = async (): Promise<never> => {
    throw new Error("unexpected_checkpoint");
  };
  const accepted = vi.fn(async () => {
    expect(published).toBe(true);
  });
  const context: CentralHostEffectContext = {
    invocation: {
      authority: plan.authority,
      sessionId: plan.selection.sessionId,
      callId: "current-call",
      signal: new AbortController().signal,
    },
    plan,
    operationRef: centralHostOperationRef(plan),
    planDigest: centralHostPlanDigest(plan),
    effect: "publish-central-host-source",
    priorPhase: "idle",
    attemptGeneration: 3,
    fenceGeneration: 3,
    assertCurrent: guard,
    checkpoint: { read: unused, recordGrantAttempt: unused, recordAccepted: accepted },
    bindings: { read: unused, claim: unused, recordAccepted: unused, recordVerified: unused },
  };
  return {
    adapter,
    context,
    accepted,
    calls,
    setPublished: () => {
      published = true;
    },
    loseResponse: () => {
      lostResponse = true;
    },
    revoke: () => {
      active = false;
    },
  };
};
test("publishes one exact operation branch with official canonical repository routes and durable receipt", async () => {
  const f = fixture();
  await expect(f.adapter.publish(f.context)).resolves.toMatchObject({
    effect: "publish-central-host-source",
    sourceSha: plan.source.reviewedSourceSha,
  });
  expect(f.calls.filter((call) => call.startsWith("POST"))).toEqual([
    "POST /repos/owned/central/git/refs",
  ]);
  expect(f.accepted).toHaveBeenCalledOnce();
});
test("pending never repeats a source mutation, including a lost response", async () => {
  const f = fixture();
  f.loseResponse();
  await expect(f.adapter.publish(f.context)).rejects.toThrow("network_unknown");
  expect(f.accepted).not.toHaveBeenCalled();
  await expect(f.adapter.publish({ ...f.context, priorPhase: "pending" })).rejects.toThrow(
    "central_host_source_unavailable",
  );
  expect(f.calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);
});
test("a preexisting branch is not adopted as this operation's publication", async () => {
  const f = fixture();
  f.setPublished();
  await expect(f.adapter.publish(f.context)).rejects.toThrow("central_host_source_unavailable");
  expect(f.calls.some((call) => call.startsWith("POST"))).toBe(false);
});
test("revoked current owner prevents even provider reads", async () => {
  const f = fixture();
  f.revoke();
  await expect(f.adapter.publish(f.context)).rejects.toThrow("revoked");
  expect(f.calls).toEqual([]);
});
