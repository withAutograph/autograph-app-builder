import { describe, expect, it, vi } from "vitest";

import {
  assertImplementationArchitecture,
  implementationFilesSchema,
  withImplementationFiles,
} from "./apply-implementation-files";

describe("approval-bound implementation files", () => {
  it("writes validated files into the successful apply overlay only", async () => {
    const files = implementationFilesSchema.parse([
      {
        content: "export default null",
        path: "apps/stock-exceptions/app/page.tsx",
      },
      {
        path: "apps/stock-exceptions/app/api/drafts/route.ts",
        content: "export async function POST() { return Response.json({ saved: true }); }",
      },
      { path: "apps/stock-exceptions/server/worker.mts", content: "export const worker = true;" },
      {
        path: "apps/stock-exceptions/db/migrations/001.sql",
        content: "CREATE TABLE drafts (id text PRIMARY KEY);",
      },
    ]);
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const writeTextFile = vi.fn(async () => {});
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const executor = vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "receipt",
    }));
    const wrapped = withImplementationFiles(executor, files);

    await expect(
      wrapped({
        appId: "stock-exceptions",
        applyRoot: "/workspace/repository",
        proposal: {} as never,
        proposalPath: "/workspace/proposal.json",
        sandbox: { writeTextFile } as never,
      }),
    ).resolves.toEqual({ exitCode: 0, stderr: "", stdout: "receipt" });

    expect(writeTextFile).toHaveBeenCalledWith({
      content: "export default null",
      path: "repository/apps/stock-exceptions/app/page.tsx",
    });
    for (const [index, file] of files.entries()) {
      expect(writeTextFile).toHaveBeenNthCalledWith(index + 1, {
        path: `repository/${file.path}`,
        content: file.content,
      });
    }
    expect(
      implementationFilesSchema.safeParse([{ content: "nope", path: "../outside.ts" }]).success,
    ).toBe(false);
  });

  it("rejects client-only persistence for apps that own kernel data", () => {
    expect(() =>
      assertImplementationArchitecture(
        [
          {
            path: "app/page.tsx",
            content:
              '"use client"; localStorage.setItem("draft", "value"); export default function Page() { return null; }',
          },
        ],
        "kernel",
      ),
    ).toThrow(/no Server Action or route handler/u);
  });

  it("accepts a server route with a narrow interactive leaf for kernel data", () => {
    expect(() =>
      assertImplementationArchitecture(
        [
          {
            path: "app/page.tsx",
            content:
              'import Form from "./form"; export default function Page() { return <Form />; }',
          },
          { path: "app/actions.ts", content: '"use server"; export async function save() {}' },
          {
            path: "app/form.tsx",
            content: '"use client"; export default function Form() { return <button />; }',
          },
        ],
        "kernel",
      ),
    ).not.toThrow();
  });
});
