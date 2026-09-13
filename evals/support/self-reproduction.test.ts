import { describe, expect, it } from "vitest";

import { auditFramework, buildRequirements, frameworkRequirements } from "./self-reproduction";

describe("self-reproduction evaluation", () => {
  it("does not mistake static configuration for instant-navigation evidence", () => {
    const audit = auditFramework([
      {
        content: "export default { cacheComponents: true, partialPrefetching: true }",
        path: "next.config.ts",
      },
      { content: "export default function Page() { return <main /> }", path: "app/page.tsx" },
      { content: "'use server'; export async function save() {}", path: "app/actions.ts" },
    ]);
    expect(
      frameworkRequirements(audit, "candidate").find(
        (item) => item.id === "candidate-instant-navigation",
      )?.status,
    ).toBe("unassessed");
  });

  it("reports unavailable generated output as blocked instead of successful", () => {
    // The explicit undefined candidate distinguishes unavailable output from an empty source set.
    // oxlint-disable-next-line unicorn/no-useless-undefined
    expect(buildRequirements(undefined).every((item) => item.status === "blocked")).toBe(true);
  });

  it("flags a static mock missing durable workflows", () => {
    const requirements = buildRequirements([
      { content: "export default () => <p>Build an app</p>", path: "app/page.tsx" },
    ]);
    expect(requirements.find((item) => item.id === "durable-draft")?.status).toBe("failed");
  });

  it("does not treat source matching as proof that a visible control works", () => {
    const source = [{ content: "Build an app Create app preview", path: "app/page.tsx" }];
    expect(
      buildRequirements(source).find((item) => item.id === "independent-creation")?.status,
    ).toBe("unassessed");
  });

  it("requires runtime evidence before treating draft persistence as passed", () => {
    const source = [{ content: "export const draft = 'persist'", path: "app/draft.ts" }];
    expect(buildRequirements(source).find((item) => item.id === "durable-draft")?.status).toBe(
      "unassessed",
    );
    expect(
      buildRequirements(source, {
        "durable-draft": { evidence: "Reload lost the draft.", status: "failed" },
      }).find((item) => item.id === "durable-draft")?.status,
    ).toBe("failed");
  });
  it("treats an imported interactive leaf as a narrow client boundary", () => {
    const audit = auditFramework([
      {
        content:
          'import Workspace from "../components/workspace"; export default function Page() { return <Workspace />; }',
        path: "app/page.tsx",
      },
      {
        content: '"use client"; export default function Workspace() { return <main />; }',
        path: "components/workspace.tsx",
      },
    ]);
    expect(audit.broadClientRoot).toBe(false);
    expect(audit.clientBoundaryPaths).toEqual(["components/workspace.tsx"]);
  });

  it("flags a client route root and ignores unreachable client modules", () => {
    const audit = auditFramework([
      {
        content: '"use client"; export default function Page() { return <main />; }',
        path: "app/page.tsx",
      },
      {
        content: '"use client"; export default function Unreachable() { return <main />; }',
        path: "components/unreachable.tsx",
      },
    ]);
    expect(audit.broadClientRoot).toBe(true);
    expect(audit.clientRouteRoots).toEqual(["app/page.tsx"]);
    expect(audit.clientBoundaryPaths).toEqual(["app/page.tsx"]);
  });

  it("resolves client boundaries through the src alias", () => {
    const audit = auditFramework([
      {
        content:
          'import Workspace from "@/components/workspace"; export default function Page() { return <Workspace />; }',
        path: "src/app/page.tsx",
      },
      {
        content: '"use client"; export default function Workspace() { return <button />; }',
        path: "src/components/workspace.tsx",
      },
    ]);
    expect(audit.clientBoundaryPaths).toEqual(["src/components/workspace.tsx"]);
    expect(audit.broadClientRoot).toBe(false);
  });
});
