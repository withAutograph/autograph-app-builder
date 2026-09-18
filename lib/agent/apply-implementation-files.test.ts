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
        content: "export async function POST() { return Response.json({ saved: true }); }",
        path: "apps/stock-exceptions/app/api/drafts/route.ts",
      },
      { content: "export const worker = true;", path: "apps/stock-exceptions/server/worker.mts" },
      {
        content: "CREATE TABLE drafts (id text PRIMARY KEY);",
        path: "apps/stock-exceptions/db/migrations/001.sql",
      },
    ]);
    const writeTextFile = vi.fn(() => Promise.resolve());
    const executor = vi.fn(() =>
      Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: "receipt",
      }),
    );
    const wrapped = withImplementationFiles(executor, files);

    await expect(
      wrapped({
        appId: "stock-exceptions",
        applyRoot: "/workspace/repository",
        proposal: {} as never,
        sandbox: { writeTextFile } as never,
      }),
    ).resolves.toEqual({ exitCode: 0, stderr: "", stdout: "receipt" });

    expect(writeTextFile).toHaveBeenCalledWith({
      content: "export default null",
      path: "repository/apps/stock-exceptions/app/page.tsx",
    });
    for (const [index, file] of files.entries()) {
      expect(writeTextFile).toHaveBeenNthCalledWith(index + 1, {
        content: file.content,
        path: `repository/${file.path}`,
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
            content:
              '"use client"; localStorage.setItem("draft", "value"); export default function Page() { return null; }',
            path: "app/page.tsx",
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
            content:
              'import Form from "./form"; export default function Page() { return <Form />; }',
            path: "app/page.tsx",
          },
          { content: '"use server"; export async function save() {}', path: "app/actions.ts" },
          {
            content: '"use client"; export default function Form() { return <button />; }',
            path: "app/form.tsx",
          },
        ],
        "kernel",
      ),
    ).not.toThrow();
  });
});
