/* oxlint-disable eslint/require-await -- Controlled sandbox ports preserve asynchronous contracts. */
import { afterEach, expect, it, vi } from "vitest";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import {
  recoverAcceptanceCheckout,
  resolveCompatibleAcceptanceRoot,
} from "../agent/acceptance-runtime-root";
import {
  context,
  preparedPlan,
  selection,
  setup,
  installManagedAcceptanceSuite,
} from "./hosted-acceptance-recovery.test-fixture";

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
});

it("recovers a missing published runtime and requires successor approval before focused managed acceptance", async () => {
  const f = setup();
  const old = await f.operations.plan(
    context,
    { ...selection.runtime, root: "/controlled/stale" },
    "original-continuity",
  );
  const oldRecord = f.rows.get(old.plan.intentId);
  if (!oldRecord) {
    throw new Error("Missing original plan");
  }
  const oldBefore = structuredClone(oldRecord);
  const fixture = await mkdtemp(path.join(tmpdir(), "builder-acceptance-recovery-"));
  temporaryRoots.push(fixture);
  const source = path.join(fixture, "published-source");
  const stale = path.join(fixture, "private-work");
  const recovered = path.join(fixture, "recovered-publication");
  await mkdir(source);
  await mkdir(stale);
  await writeFile(path.join(source, "release.txt"), preparedPlan.release.id);
  await writeFile(path.join(stale, "release.txt"), "older-release");
  await writeFile(path.join(stale, "private.txt"), "retain private edits");
  const promisifyExecFile: (fn: typeof execFile) => typeof execFile.__promisify__ = promisify;
  const exec = promisifyExecFile(execFile);
  const git = async (...args: string[]) => await exec("git", ["-C", source, ...args]);
  await git("init");
  await git("add", "release.txt");
  await git(
    "-c",
    "user.name=Controlled fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "published release",
  );
  const head = await git("rev-parse", "HEAD");
  const revision = head.stdout.trim();
  const privateWork = { note: "retain private edits", root: stale };
  const recover = vi.fn(
    async () =>
      await recoverAcceptanceCheckout({
        repositoryUrl: source,
        revision,
        root: recovered,
        sandbox: {
          run: async ({ command, workingDirectory }) => {
            const output = await exec("/bin/sh", ["-c", command], { cwd: workingDirectory });
            return { exitCode: 0, stderr: output.stderr, stdout: output.stdout };
          },
        },
        signal: new AbortController().signal,
        workingDirectory: fixture,
      }),
  );
  const root = await resolveCompatibleAcceptanceRoot({
    describe: async (candidate) => {
      try {
        return await readFile(path.join(candidate, "release.txt"), "utf-8");
      } catch {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- Missing checkout is the resolver contract.
        return undefined;
      }
    },
    recover,
    releaseId: preparedPlan.release.id,
    roots: [privateWork.root, "/controlled/missing-publication"],
  });
  expect(root).toBe(recovered);
  expect(recover).toHaveBeenCalledOnce();
  expect(privateWork).toEqual({ note: "retain private edits", root: stale });
  expect(await readFile(path.join(stale, "private.txt"), "utf-8")).toBe("retain private edits");
  const browserSelection = { maxFailures: 1, retries: 0, testName: "@acceptance", workers: 1 };
  const successor = await f.operations.plan(
    context,
    { ...selection.runtime, browserSelection, root },
    "recovered-focused-continuity",
    { predecessorIntentId: old.plan.intentId },
  );
  expect(successor.plan.runtime.root).toBe(recovered);
  expect(successor.plan.predecessorIntentId).toBe(old.plan.intentId);
  expect(f.rows.get(old.plan.intentId)).toMatchObject({
    ...oldBefore,
    revision: oldBefore.revision + 1,
    supersededBy: successor.plan.intentId,
  });
  expect(f.rows.get(old.plan.intentId)?.plan).toEqual(oldBefore.plan);
  expect(f.events).toEqual([]);
  await expect(
    f.operations.execute(context, successor.request, "fresh-approval-call"),
  ).rejects.toMatchObject({ code: "authorization_required" });
  expect(f.events).toEqual([]);
  f.deps.readApproval = async (_context, request, callId) =>
    request.planDigest === successor.request.planDigest
      ? {
          ...request,
          approvalId: "fresh-human-approval",
          approvedByCallId: callId ?? "fresh-approval-call",
        }
      : null;

  installManagedAcceptanceSuite(f, root, fixture, browserSelection);
  const outcome = await f.operations.execute(context, successor.request, "fresh-approval-call");
  expect(outcome.state).toBe("settled");
  expect(await readFile(path.join(fixture, "durable.txt"), "utf-8")).toBe("preserved-value");
  expect(f.rows.get(successor.plan.intentId)?.suiteCommandId).toBe("focused-command");
  await expect(f.operations.execute(context, old.request, "old-call")).rejects.toMatchObject({
    code: "reconciliation_required",
  });
  expect(f.rows.get(old.plan.intentId)?.plan).toEqual(oldBefore.plan);
});
