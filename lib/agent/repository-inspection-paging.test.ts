/* oxlint-disable anti-slop/no-module-mocking, eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Exercise real paging and serialization while controlling only the baseline authorization port; drain continuation pages in protocol order. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxSession } from "eve/sandbox";
import { readRepositoryInspectionPage } from "../../agent/tools/inspect_repository";
import { readableAppBaselinePaths } from "../repository/app-baseline";
import {
  EVE_NATIVE_RESULT_PAGE_BYTES,
  serializedNativeActionResultBytes,
} from "../eve/payload-envelope";

vi.mock("../repository/app-baseline", async (importOriginal) => {
  const original = await importOriginal<{
    readableAppBaselinePaths: typeof readableAppBaselinePaths;
  }>();
  return { ...original, readableAppBaselinePaths: vi.fn(original.readableAppBaselinePaths) };
});

const metadata = {
  callId: "inspection-call",
  toolName: "inspect_repository",
  turnId: "inspection-turn",
};
const fixture = (files: Record<string, string>) => {
  const sandbox: Pick<SandboxSession, "readTextFile"> = {
    readTextFile: vi.fn<SandboxSession["readTextFile"]>(
      async ({ path }) =>
        await Promise.resolve(files[path.replace(/^\/workspace\/repository\//u, "")] ?? null),
    ),
  };
  return { baseline: undefined, files, metadata, paths: Object.keys(files), sandbox };
};
const drain = async (input: Parameters<typeof readRepositoryInspectionPage>[0]) => {
  const pages: Awaited<ReturnType<typeof readRepositoryInspectionPage>>[] = [];
  const files = new Map<string, string>();
  const missingPaths: string[] = [];
  let cursor;
  do {
    const page = await readRepositoryInspectionPage({ ...input, ...cursor });
    expect(serializedNativeActionResultBytes(page, input.metadata)).toBeLessThanOrEqual(
      EVE_NATIVE_RESULT_PAGE_BYTES,
    );
    pages.push(page);
    for (const file of page.files) {
      const prefix = files.get(file.path) ?? "";
      expect(file.offsetBytes ?? 0).toBe(Buffer.byteLength(prefix));
      files.set(file.path, prefix + file.content);
    }
    missingPaths.push(...page.missingPaths);
    if (page.continuation !== undefined && cursor !== undefined) {
      expect(
        page.continuation.pathIndex > cursor.pathIndex ||
          (page.continuation.pathIndex === cursor.pathIndex &&
            page.continuation.offsetBytes > cursor.offsetBytes),
      ).toBe(true);
    }
    cursor = page.continuation;
  } while (cursor !== undefined);
  return { files, missingPaths, pages };
};

describe("repository inspection paging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves the original small result shape, empty files, requested names and missing paths", async () => {
    const input = fixture({ "README.md": "read me", "empty.ts": "" });
    input.paths = ["/workspace/repository/README.md", "missing.ts", "empty.ts", "README.md"];
    expect(await readRepositoryInspectionPage(input)).toEqual({
      files: [
        { content: "read me", path: "/workspace/repository/README.md" },
        { content: "", path: "empty.ts" },
        { content: "read me", path: "README.md" },
      ],
      missingPaths: ["missing.ts"],
    });
  });

  it("round-trips multi-page Unicode and JSON-escaped bytes with deterministic cursor retries", async () => {
    const content = '🙂é"\\\n'.repeat(Math.ceil(EVE_NATIVE_RESULT_PAGE_BYTES / 4));
    const input = fixture({ "components/large.tsx": content });
    const first = await readRepositoryInspectionPage(input);
    expect(first.continuation).toBeDefined();
    expect(await readRepositoryInspectionPage(input)).toEqual(first);
    const replay = await readRepositoryInspectionPage({ ...input, ...first.continuation });
    expect(await readRepositoryInspectionPage({ ...input, ...first.continuation })).toEqual(replay);
    const result = await drain(input);
    expect(result.pages.length).toBeGreaterThan(1);
    expect(result.files.get("components/large.tsx")).toBe(content);
    for (const page of result.pages) {
      for (const file of page.files) {
        expect(file.content).not.toContain("�");
      }
    }
  });

  it("continues across files and missing paths without skipping or duplicating source", async () => {
    const input = fixture({
      "first.ts": "a".repeat(EVE_NATIVE_RESULT_PAGE_BYTES - 400),
      "second.ts": "second🙂".repeat(EVE_NATIVE_RESULT_PAGE_BYTES / 8),
      "last.ts": "last",
    });
    input.paths = [
      "missing-before",
      "first.ts",
      "missing-middle",
      "second.ts",
      "missing-after",
      "last.ts",
    ];
    const result = await drain(input);
    expect([...result.files]).toEqual([
      ["first.ts", "a".repeat(EVE_NATIVE_RESULT_PAGE_BYTES - 400)],
      ["second.ts", "second🙂".repeat(EVE_NATIVE_RESULT_PAGE_BYTES / 8)],
      ["last.ts", "last"],
    ]);
    expect(result.missingPaths).toEqual(["missing-before", "missing-middle", "missing-after"]);
    expect(result.pages.length).toBeGreaterThan(1);
  });

  it("pages oversized missing-path metadata and preserves the complete requested work", async () => {
    const input = fixture({});
    input.paths = Array.from({ length: 800 }, (_, index) => `${"segment/".repeat(250)}${index}.ts`);
    const result = await drain(input);
    expect(result.pages.length).toBeGreaterThan(1);
    expect(result.missingPaths).toEqual(input.paths);
    expect(result.files.size).toBe(0);
  });

  it("includes long native frame identifiers when choosing a page boundary", async () => {
    const input = fixture({ "large.txt": "content".repeat(EVE_NATIVE_RESULT_PAGE_BYTES / 7) });
    input.metadata = { ...metadata, callId: "call".repeat(600), turnId: "turn".repeat(600) };
    const result = await drain(input);
    expect(result.files.get("large.txt")).toBe("content".repeat(EVE_NATIVE_RESULT_PAGE_BYTES / 7));
  });

  it("restarts an invalid Unicode cursor at byte zero and retrieves the whole current file", async () => {
    const content = "🙂é".repeat(Math.ceil(EVE_NATIVE_RESULT_PAGE_BYTES / 4));
    const input = fixture({ "unicode.txt": content });
    const first = await readRepositoryInspectionPage({ ...input, offsetBytes: 1 });
    const [firstChunk] = first.files;
    expect(firstChunk).toMatchObject({
      offsetBytes: 0,
      restartedFromOffsetBytes: 1,
    });
    expect(first.continuation).toBeDefined();

    let combined = firstChunk?.content ?? "";
    let cursor = first.continuation;
    while (cursor !== undefined) {
      const page = await readRepositoryInspectionPage({ ...input, ...cursor });
      const [chunk] = page.files;
      expect(chunk?.offsetBytes).toBe(Buffer.byteLength(combined, "utf-8"));
      combined += chunk?.content ?? "";
      cursor = page.continuation;
    }
    expect(combined).toBe(content);
    expect(combined).not.toContain("�");
  });

  it("restarts an old cursor beyond a truncated file and returns its complete current content", async () => {
    const input = fixture({ "large.txt": "a".repeat(EVE_NATIVE_RESULT_PAGE_BYTES * 2) });
    const original = await readRepositoryInspectionPage(input);
    expect(original.continuation).toBeDefined();
    const previousOffset = original.continuation?.offsetBytes;
    input.files["large.txt"] = "current🙂";

    const restarted = await readRepositoryInspectionPage({ ...input, ...original.continuation });
    expect(restarted.files).toEqual([
      {
        content: "current🙂",
        offsetBytes: 0,
        path: "large.txt",
        restartedFromOffsetBytes: previousOffset,
      },
    ]);
    expect(restarted.continuation).toBeUndefined();
  });

  it("rechecks the existing baseline restriction before any continued content read", async () => {
    const input = fixture({ "first.ts": "first", "restricted.ts": "private release" });
    vi.mocked(readableAppBaselinePaths).mockResolvedValueOnce(["first.ts"]);
    await expect(
      readRepositoryInspectionPage({ ...input, pathIndex: 1, offsetBytes: 1 }),
    ).rejects.toThrow("outside the selected app baseline");
    expect(input.sandbox.readTextFile).not.toHaveBeenCalled();
  });

  it("accepts newly added requested files without a frozen source listing or digest gate", async () => {
    const files = { "new-file.ts": "export const current = true;" };
    const result = await readRepositoryInspectionPage(fixture(files));
    expect(result.files).toEqual([{ content: files["new-file.ts"], path: "new-file.ts" }]);
    expect(result.continuation).toBeUndefined();
  });
});
