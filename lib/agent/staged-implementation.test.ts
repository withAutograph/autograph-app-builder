import { describe, expect, it, vi } from "vitest";
import { assertImplementationArchitecture } from "./apply-implementation-files";
import { stageImplementationFiles } from "./staged-implementation";

vi.mock("eve/context", () => ({
  defineState: (_name: string, initial: () => unknown) => {
    let state = initial();
    return {
      get: () => state,
      update: (change: (current: unknown) => unknown) => {
        state = change(state);
      },
    };
  },
}));

describe("approved implementation repair staging", () => {
  it("preserves full UI submission after architecture rejection and partial backend repair", () => {
    const binding = { appSpecDigest: "spec", proposalDigest: "proposal" };
    const page = {
      content: "export default function Page() { return <main>Workspace</main>; }",
      path: "apps/example/app/page.tsx",
    };
    const first = stageImplementationFiles({ ...binding, files: [page] });
    expect(() => assertImplementationArchitecture(first, "kernel")).toThrow();
    const repair = {
      content: '"use server"; export async function save() {}',
      path: "apps/example/app/actions.ts",
    };
    const merged = stageImplementationFiles({ ...binding, files: [repair] });
    expect(merged).toEqual([page, repair]);
    expect(() => assertImplementationArchitecture(merged, "kernel")).not.toThrow();
  });
  it("replaces supplied paths while retaining omitted files", () => {
    const binding = { appSpecDigest: "replace", proposalDigest: "replace" };
    stageImplementationFiles({
      ...binding,
      files: [
        { content: "old", path: "a" },
        { content: "keep", path: "b" },
      ],
    });
    expect(
      stageImplementationFiles({ ...binding, files: [{ content: "new", path: "a" }] }),
    ).toEqual([
      { content: "new", path: "a" },
      { content: "keep", path: "b" },
    ]);
  });
  it("starts fresh when proposal or accepted specification changes", () => {
    stageImplementationFiles({
      appSpecDigest: "old",
      files: [{ content: "old", path: "old" }],
      proposalDigest: "old",
    });
    expect(
      stageImplementationFiles({ appSpecDigest: "old", files: [], proposalDigest: "new" }),
    ).toEqual([]);
    stageImplementationFiles({
      appSpecDigest: "old",
      files: [{ content: "other", path: "other" }],
      proposalDigest: "new",
    });
    expect(
      stageImplementationFiles({ appSpecDigest: "new", files: [], proposalDigest: "new" }),
    ).toEqual([]);
  });
});
