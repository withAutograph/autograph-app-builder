import { describe, expect, it } from "vitest";
import { renderReport } from "./report";
import { scoreAdherence } from "./evidence";

describe("adherence report", () => {
  it("links escaped source findings and annotated regions without changing screenshots", () => {
    const html = renderReport({
      createdAt: "today",
      source: {},
      judge: { status: "not-run" },
      sourceFiles: [
        { path: "app.tsx", content: '<script>alert("x")</script>' },
      ],
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
});
