import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { prepareSelfReproductionTemplateSource } from "./self-reproduction-template-source";

describe("self-contained template source", () => {
  it("clones the canonical template using structured arguments then records its revision", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "template-source-"));
    const runGit = vi
      .fn()
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("actual-head")
      .mockResolvedValueOnce("https://github.com/withAutograph/arrusted-development.git");
    try {
      const result = await prepareSelfReproductionTemplateSource({ outputDirectory, runGit });
      expect(runGit.mock.calls[0]?.[0]).toEqual([
        "clone",
        "--branch",
        "main",
        "--single-branch",
        "https://github.com/withAutograph/arrusted-development.git",
        join(outputDirectory, "runtime-source", "arrusted-development"),
      ]);
      expect(result.revision).toBe("actual-head");
      expect(result.acquisition).toBe("canonical-clone");
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });
  it("preserves an explicitly supplied checkout and strips HTTP remote credentials", async () => {
    const runGit = vi
      .fn()
      .mockResolvedValueOnce("local-head")
      .mockResolvedValueOnce("https://user:secret@github.com/example/template.git");
    const result = await prepareSelfReproductionTemplateSource({
      outputDirectory: "/unused",
      providedCheckout: "/tmp/user checkout",
      runGit,
    });
    expect(runGit.mock.calls.map(([args]) => args[0])).toEqual(["rev-parse", "remote"]);
    expect(result.remote).toBe("https://github.com/example/template.git");
    expect(result.sourcePath).toBe("/tmp/user checkout");
  });
  it("surfaces actual clone failure without continuing to revision inspection", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "template-source-"));
    const runGit = vi.fn().mockRejectedValue(new Error("GitHub access denied"));
    try {
      await expect(
        prepareSelfReproductionTemplateSource({ outputDirectory, runGit }),
      ).rejects.toThrow("GitHub access denied");
      expect(runGit).toHaveBeenCalledTimes(1);
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });
});
