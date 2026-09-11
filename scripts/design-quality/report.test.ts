import { describe, expect, it } from "vitest";
import { renderReport } from "./report";
import { scoreAdherence } from "./evidence";

describe("adherence report", () => {
  it("shows escaped case context without claiming intended outcomes passed", () => {
    const html = renderReport({
      createdAt: "today",
      source: {},
      judge: {},
      captures: [],
      case: {
        id: "position-request",
        title: "Position <request>",
        notes: "Synthetic only",
        evidence: [{ repo: "ag2", path: "docs/example.md", status: "planned" }],
        reviewQuestions: ["Can a user correct the form?"],
        outcomes: ["Save a draft"],
      },
    });
    expect(html).toContain("Position &lt;request&gt;");
    expect(html).toContain("docs/example.md");
    expect(html).toContain("Intended outcomes, not asserted results");
    expect(html).toContain('href="report.json"');
  });
  it("links escaped source findings and annotated regions without changing screenshots", () => {
    const html = renderReport({
      createdAt: "today",
      source: {},
      judge: { status: "not-run" },
      sourceFiles: [{ path: "app.tsx", content: '<script>alert("x")</script>' }],
      adherence: scoreAdherence([
        {
          id: "a",
          dimension: "styling",
          verdict: "nonconforming",
          provenance: "generated",
          evidence: "static",
          summary: "<img onerror=bad>",
          source: { path: "app.tsx", line: 1 },
          capture: "desktop-wide-0",
          region: { x: 1, y: 2, width: 20, height: 10 },
        },
      ]),
      captures: [
        {
          name: "desktop-wide-0",
          state: "initial",
          width: 100,
          height: 100,
          measurements: {},
          interaction: {},
        },
      ],
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
    const base = { createdAt: "today", source: {}, judge: {}, captures: [] };
    expect(renderReport({ ...base, adherence: scoreAdherence([]) })).toContain(
      "Arrusted adherence: Not assessed",
    );
    expect(renderReport(base)).toContain("Historical report");
  });
  it("renders generated-source diagnostics with an escaped source location", () => {
    const html = renderReport({
      createdAt: "today",
      source: {
        implementationDiagnostics: [
          {
            path: "src/Screen.tsx",
            line: 2,
            column: 8,
            code: 2532,
            message: "Object is possibly 'undefined'.",
          },
        ],
      },
      sourceFiles: [{ path: "src/Screen.tsx", content: "first\nsecond" }],
      judge: {},
      captures: [],
    });
    expect(html).toContain("Generated-code implementation diagnostics (1)");
    expect(html).toContain("src/Screen.tsx:2:8");
    expect(html).toContain("Object is possibly &#39;undefined&#39;.");
  });
  it("shows candidate provenance without giving it adherence credit", () => {
    const adherence = scoreAdherence([
      {
        id: "candidate",
        dimension: "styling",
        verdict: "unassessed",
        provenance: "unknown",
        evidence: "browser",
        summary: "Requires review",
        originCandidate: {
          provenance: "generated",
          reason: "May be shared <script>",
          source: { path: "app.tsx", line: 4 },
        },
      },
    ]);
    const html = renderReport({
      createdAt: "today",
      source: {},
      judge: {},
      captures: [],
      adherence,
    });
    expect(adherence.score).toBeNull();
    expect(html).toContain("Possible generated source (unassessed): app.tsx:4");
    expect(html).toContain("May be shared &lt;script&gt;");
    expect(html).not.toContain("May be shared <script>");
  });
});
