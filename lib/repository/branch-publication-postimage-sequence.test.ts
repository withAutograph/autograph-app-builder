import { describe, expect, it } from "vitest";

import { assertBranchPublicationPostimageSequence } from "./node-branch-worktree-publication";

const regular = (digest: string) => ({ digest, kind: "regular" as const, mode: "644" });
const base = async function* base() {
  yield { path: "a.txt", state: regular("a") };
  yield { path: "b.txt", state: regular("b") };
  yield { path: "c.txt", state: regular("c") };
};
const changes = [
  { before: { digest: "b", mode: "644" }, kind: "deleted" as const, path: "b.txt" },
  {
    after: { digest: "C", mode: "644" },
    before: { digest: "c", mode: "644" },
    kind: "modified" as const,
    path: "c.txt",
  },
  { after: { digest: "d", mode: "644" }, kind: "added" as const, path: "d.txt" },
];
const observed = [
  { path: "a.txt", state: regular("a") },
  { path: "b.txt", state: { kind: "absent" as const } },
  { path: "c.txt", state: regular("C") },
  { path: "d.txt", state: regular("d") },
];

describe("streamed branch publication postimage comparison", () => {
  it("accepts exact additions, modifications, and deletions", async () => {
    await expect(
      assertBranchPublicationPostimageSequence({ base: base(), changes, observed }),
    ).resolves.toBeUndefined();
  });

  it("rejects an extra path and changed content", async () => {
    await expect(
      assertBranchPublicationPostimageSequence({
        base: base(),
        changes,
        observed: [...observed, { path: "extra.txt", state: regular("x") }],
      }),
    ).rejects.toThrow(/unapproved path/u);
    await expect(
      assertBranchPublicationPostimageSequence({
        base: base(),
        changes,
        observed: observed.map((entry) =>
          entry.path === "c.txt" ? { path: entry.path, state: regular("wrong") } : entry,
        ),
      }),
    ).rejects.toThrow(/c\.txt/u);
  });
});
