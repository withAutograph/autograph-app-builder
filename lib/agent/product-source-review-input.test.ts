import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { readProductReviewSource } from "./product-source-review-input";

it("retains only exact observed source bytes and explicitly accounts for unreadable or moving files", async () => {
  const source = new Map([
    ["apps/example/page.tsx", "implemented action"],
    ["apps/example/moving.ts", "changed after snapshot"],
    ["package.json", "{}"],
  ]);
  const paths = [...source.keys(), "apps/example/error.ts", "apps/example/logo.png"];
  const result = await readProductReviewSource({
    appId: "example",
    applyRoot: "/workspace/repository",
    changedPaths: [],
    observed: {
      files: paths.map((path) => ({
        digest: createHash("sha256")
          .update(path.endsWith("moving.ts") ? "before" : (source.get(path) ?? ""))
          .digest("hex"),
        mode: "644",
        path,
      })),
      treeDigest: "tree",
    },
    sandbox: {
      readTextFile: async ({ path }) => {
        await Promise.resolve();
        if (path.endsWith("error.ts")) {
          throw new Error("secret error");
        }
        return source.get(path.replace("repository/", "")) ?? null;
      },
    },
  });
  expect(result.files.map((file) => file.path)).toEqual(["apps/example/page.tsx", "package.json"]);
  expect(result.omissions).toContain("apps/example/moving.ts: changed during observation");
  expect(result.omissions).toContain("apps/example/error.ts: unreadable");
  expect(JSON.stringify(result)).not.toContain("secret error");
});

it("does not charge omitted large files against later small source files", async () => {
  const source = [
    { content: "a".repeat(400_001), path: "apps/example/a.ts" },
    { content: "useful implementation", path: "apps/example/b.ts" },
  ];
  const result = await readProductReviewSource({
    appId: "example",
    applyRoot: "/workspace/repository",
    changedPaths: [],
    observed: {
      files: source.map(({ path, content }) => ({
        digest: createHash("sha256").update(content).digest("hex"),
        mode: "644",
        path,
      })),
      treeDigest: "tree",
    },
    sandbox: {
      readTextFile: async ({ path }) => {
        await Promise.resolve();
        return source.find((file) => path.endsWith(file.path))?.content ?? null;
      },
    },
  });
  expect(result.files).toEqual([source[1]]);
  expect(result.omissions).toContain("apps/example/a.ts: model context omitted");
});
