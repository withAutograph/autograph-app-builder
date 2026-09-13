import type { Page } from "playwright";
import { describe, expect, it } from "vitest";

import { createWorkflowAdapters } from "./workflow-adapter";

describe("self-reproduction default workflow adapter", () => {
  it("is self-contained and omits sides whose runtime URL is unavailable", () => {
    expect(createWorkflowAdapters({ outputRoot: "/tmp/evidence" })).toEqual({});
  });

  it("binds each supplied runtime to evaluator-owned adapters", () => {
    const adapters = createWorkflowAdapters({
      candidateUrl: "http://127.0.0.1:4173",
      outputRoot: "/tmp/evidence",
      referenceUrl: "https://localhost:3001",
    });
    expect(adapters.reference).toBeDefined();
    expect(adapters.candidate).toBeDefined();
  });

  it("classifies an absent reference fixture as not-run rather than missing product functionality", async () => {
    const { reference } = createWorkflowAdapters({
      outputRoot: "/tmp/evidence",
      referenceUrl: "https://localhost:3001",
    });
    const prepared = await reference?.prepare({} as Page, "app-creation");
    expect(prepared).toEqual({
      disposition: "not-run",
      ready: false,
      reason: "The checked-in reference adapter has no bounded real fixture for app-creation.",
    });
  });
});
