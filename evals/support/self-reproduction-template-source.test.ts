import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareSelfReproductionTemplateSource } from "./self-reproduction-template-source";

const createGitStub = (results: (string | Error)[]) => {
  const calls: { args: string[]; cwd?: string }[] = [];
  const runGit = async (args: string[], cwd?: string): Promise<string> => {
    calls.push({ args, cwd });
    const result = results.shift();
    if (result instanceof Error) {
      throw result;
    }
    return await Promise.resolve(result ?? "");
  };
  return { calls, runGit };
};

describe("self-contained template source", () => {
  it("clones the canonical template using structured arguments then records its revision", async () => {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "template-source-"));
    const { calls, runGit } = createGitStub([
      "",
      "actual-head",
      "https://github.com/withAutograph/arrusted-development.git",
    ]);
    try {
      const result = await prepareSelfReproductionTemplateSource({ outputDirectory, runGit });
      expect(calls[0]?.args).toEqual([
        "clone",
        "--branch",
        "main",
        "--single-branch",
        "https://github.com/withAutograph/arrusted-development.git",
        path.join(outputDirectory, "runtime-source", "arrusted-development"),
      ]);
      expect(result.revision).toBe("actual-head");
      expect(result.acquisition).toBe("canonical-clone");
    } finally {
      await rm(outputDirectory, { force: true, recursive: true });
    }
  });
  it("preserves an explicitly supplied checkout and strips HTTP remote credentials", async () => {
    const { calls, runGit } = createGitStub([
      "local-head",
      "https://user:secret@github.com/example/template.git",
    ]);
    const providedCheckout = await mkdtemp(path.join(tmpdir(), "user-checkout-"));
    try {
      const result = await prepareSelfReproductionTemplateSource({
        outputDirectory: providedCheckout,
        providedCheckout,
        runGit,
      });
      expect(calls.map(({ args }) => args[0])).toEqual(["rev-parse", "remote"]);
      expect(result.remote).toBe("https://github.com/example/template.git");
      expect(result.sourcePath).toBe(providedCheckout);
    } finally {
      await rm(providedCheckout, { force: true, recursive: true });
    }
  });
  it("surfaces actual clone failure without continuing to revision inspection", async () => {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "template-source-"));
    const { calls, runGit } = createGitStub([new Error("GitHub access denied")]);
    try {
      await expect(
        prepareSelfReproductionTemplateSource({ outputDirectory, runGit }),
      ).rejects.toThrow("GitHub access denied");
      expect(calls).toHaveLength(1);
    } finally {
      await rm(outputDirectory, { force: true, recursive: true });
    }
  });
});
