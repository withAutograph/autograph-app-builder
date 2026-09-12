import { describe, expect, it } from "vitest";

import { auditFramework, buildRequirements, frameworkRequirements } from "./self-reproduction";

describe("self-reproduction evaluation", () => {
  it("does not mistake static configuration for instant-navigation evidence", () => {
    const audit = auditFramework([
      {
        path: "next.config.ts",
        content: "export default { cacheComponents: true, partialPrefetching: true }",
      },
      { path: "app/page.tsx", content: "export default function Page() { return <main /> }" },
      { path: "app/actions.ts", content: "'use server'; export async function save() {}" },
    ]);
    expect(
      frameworkRequirements(audit, "candidate").find(
        (item) => item.id === "candidate-instant-navigation",
      )?.status,
    ).toBe("unassessed");
  });

  it("reports unavailable generated output as blocked instead of successful", () => {
    expect(buildRequirements(undefined).every((item) => item.status === "blocked")).toBe(true);
  });

  it("flags a static mock missing durable workflows", () => {
    const requirements = buildRequirements([
      { path: "app/page.tsx", content: "export default () => <p>Build an app</p>" },
    ]);
    expect(requirements.find((item) => item.id === "durable-draft")?.status).toBe("failed");
  });

  it("does not treat source matching as proof that a visible control works", () => {
    const source = [{ path: "app/page.tsx", content: "Build an app Create app preview" }];
    expect(
      buildRequirements(source).find((item) => item.id === "independent-creation")?.status,
    ).toBe("unassessed");
  });

  it("requires runtime evidence before treating draft persistence as passed", () => {
    const source = [{ path: "app/draft.ts", content: "export const draft = 'persist'" }];
    expect(buildRequirements(source).find((item) => item.id === "durable-draft")?.status).toBe(
      "unassessed",
    );
    expect(
      buildRequirements(source, {
        "durable-draft": { status: "failed", evidence: "Reload lost the draft." },
      }).find((item) => item.id === "durable-draft")?.status,
    ).toBe("failed");
  });
});
