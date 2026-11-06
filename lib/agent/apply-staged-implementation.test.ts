import { describe, expect, it } from "vitest";
import {
  implementationArchitectureDiagnostics,
  implementationFilesSchema,
} from "./apply-implementation-files";

describe("apply tool implementation files", () => {
  it("accepts optional Build summaries beyond the card's presentation budget", () => {
    const productSummary = "Summarize the approved app scope. ".repeat(30).trim();
    expect(implementationFilesSchema.parse([])).toEqual([]);
    expect(productSummary.length).toBeGreaterThan(500);
  });

  it("reports missing server writes for kernel implementations", () => {
    const diagnostics = implementationArchitectureDiagnostics(
      [
        {
          content: "export default function Page() { return <main>Workspace</main>; }",
          path: "apps/app/app/page.tsx",
        },
      ],
      "kernel",
    );

    expect(diagnostics).toContain(
      "No Server Action or route handler was recognized in the submitted files. Verify the complete app has the server-authorized persistence required by the accepted design.",
    );
  });

  it("recognizes server actions and avoids kernel diagnostics for other schema kinds", () => {
    const action = {
      content: '"use server"; export async function save() {}',
      path: "apps/app/app/actions.ts",
    };

    expect(implementationArchitectureDiagnostics([action], "kernel")).toEqual([]);
    expect(implementationArchitectureDiagnostics([], "none")).toEqual([]);
  });

  it("warns when a client component persists data in browser storage", () => {
    expect(
      implementationArchitectureDiagnostics(
        [
          {
            content: '"use client"; localStorage.setItem("draft", "value");',
            path: "apps/app/app/page.tsx",
          },
        ],
        "kernel",
      ),
    ).toEqual([
      "No Server Action or route handler was recognized in the submitted files. Verify the complete app has the server-authorized persistence required by the accepted design.",
      "apps/app/app/page.tsx references browser storage. Verify it holds only transient presentation state and durable writes use the server-owned store.",
      "apps/app/app/page.tsx is a Client Component. Review server-rendered initial state and narrow interactive leaves where appropriate.",
    ]);
  });
});
