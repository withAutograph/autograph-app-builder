import type { Page } from "playwright";
import { describe, expect, it, vi } from "vitest";

import { createWorkflowAdapters } from "./workflow-adapter";

describe("self-reproduction default workflow adapter", () => {
  it("is self-contained and omits sides whose runtime URL is unavailable", () => {
    expect(createWorkflowAdapters({ outputRoot: "/tmp/evidence" })).toEqual({});
  });

  it("binds each supplied runtime to evaluator-owned adapters", () => {
    const adapters = createWorkflowAdapters({
      outputRoot: "/tmp/evidence",
      referenceUrl: "https://localhost:3001",
      candidateUrl: "http://127.0.0.1:4173",
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
      ready: false,
      disposition: "not-run",
      reason: "The checked-in reference adapter has no bounded real fixture for app-creation.",
    });
  });
});

describe("candidate workflow evidence boundaries", () => {
  it("preserves the microfrontend base path when opening the candidate", async () => {
    const { candidate } = createWorkflowAdapters({
      outputRoot: "/tmp/evidence",
      candidateUrl: "https://candidate.example/replica/",
    });
    const goto = vi.fn().mockResolvedValue({ ok: () => true });
    expect(await candidate?.prepare({ goto } as unknown as Page, "documentation")).toEqual({
      ready: true,
    });
    expect(goto).toHaveBeenCalledWith("https://candidate.example/replica/");
  });

  it.each(["authentication", "durable-draft", "app-creation", "independent-child"] as const)(
    "leaves %s unassessed when its candidate fixture is unavailable",
    async (workflow) => {
      const { candidate } = createWorkflowAdapters({
        outputRoot: "/tmp/evidence",
        candidateUrl: "https://candidate.example/replica/",
      });
      const goto = vi.fn();
      expect(await candidate?.prepare({ goto } as unknown as Page, workflow)).toMatchObject({
        ready: false,
        disposition: "not-run",
      });
      expect(goto).not.toHaveBeenCalled();
    },
  );

  it("does not credit reference auth restoration or cross-user isolation without fixtures", async () => {
    const { reference } = createWorkflowAdapters({
      outputRoot: "/tmp/evidence",
      referenceUrl: "https://localhost:3001",
    });
    expect(await reference?.prepare({} as Page, "authentication")).toMatchObject({
      ready: false,
      disposition: "not-run",
    });
  });
});
