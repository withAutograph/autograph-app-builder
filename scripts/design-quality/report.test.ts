import { describe, expect, it } from "vitest";
import { renderReport } from "./report";
import { scoreAdherence } from "./evidence";

describe("adherence report", () => {
  it("shows escaped case context without claiming intended outcomes passed", () => {
    const html = renderReport({
      captures: [],
      case: {
        evidence: [{ path: "docs/example.md", repo: "ag2", status: "planned" }],
        id: "position-request",
        notes: "Synthetic only",
        outcomes: ["Save a draft"],
        reviewQuestions: ["Can a user correct the form?"],
        title: "Position <request>",
      },
      createdAt: "today",
      judge: {},
      source: {},
    });
    expect(html).toContain("Position &lt;request&gt;");
    expect(html).toContain("docs/example.md");
    expect(html).toContain("Intended outcomes, not asserted results");
    expect(html).toContain('href="report.json"');
  });
  it("links escaped source findings and annotated regions without changing screenshots", () => {
    const html = renderReport({
      adherence: scoreAdherence([
        {
          capture: "desktop-wide-0",
          dimension: "styling",
          evidence: "static",
          id: "a",
          provenance: "generated",
          region: { height: 10, width: 20, x: 1, y: 2 },
          source: { line: 1, path: "app.tsx" },
          summary: "<img onerror=bad>",
          verdict: "nonconforming",
        },
      ]),
      captures: [
        {
          height: 100,
          interaction: {},
          measurements: {},
          name: "desktop-wide-0",
          state: "initial",
          width: 100,
        },
      ],
      createdAt: "today",
      judge: { status: "not-run" },
      source: {},
      sourceFiles: [{ content: '<script>alert("x")</script>', path: "app.tsx" }],
    });
    expect(html).toContain('href="#source-0"');
    expect(html).toContain('href="#finding-0"');
    expect(html).toContain("left:1%;top:2%;width:20%;height:10%");
    expect(html).toContain("Original, unmodified screenshot");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<img onerror");
    expect(html).toContain("0% (0/1)");
  });
  it("renders empty and historical evidence without inventing scores", () => {
    const base = { captures: [], createdAt: "today", judge: {}, source: {} };
    expect(renderReport({ ...base, adherence: scoreAdherence([]) })).toContain(
      "Arrusted adherence: Not assessed",
    );
    expect(renderReport(base)).toContain("Historical report");
  });
  it("renders generated-source diagnostics with an escaped source location", () => {
    const html = renderReport({
      captures: [],
      createdAt: "today",
      judge: {},
      source: {
        implementationDiagnostics: [
          {
            code: 2532,
            column: 8,
            line: 2,
            message: "Object is possibly 'undefined'.",
            path: "src/Screen.tsx",
          },
        ],
      },
      sourceFiles: [{ content: "first\nsecond", path: "src/Screen.tsx" }],
    });
    expect(html).toContain("Generated-code implementation diagnostics (1)");
    expect(html).toContain("src/Screen.tsx:2:8");
    expect(html).toContain("Object is possibly &#39;undefined&#39;.");
  });
  it("shows candidate provenance without giving it adherence credit", () => {
    const adherence = scoreAdherence([
      {
        dimension: "styling",
        evidence: "browser",
        id: "candidate",
        originCandidate: {
          provenance: "generated",
          reason: "May be shared <script>",
          source: { line: 4, path: "app.tsx" },
        },
        provenance: "unknown",
        summary: "Requires review",
        verdict: "unassessed",
      },
    ]);
    const html = renderReport({
      adherence,
      captures: [],
      createdAt: "today",
      judge: {},
      source: {},
    });
    expect(adherence.score).toBeNull();
    expect(html).toContain("Possible generated source (unassessed): app.tsx:4");
    expect(html).toContain("May be shared &lt;script&gt;");
    expect(html).not.toContain("May be shared <script>");
  });
});
