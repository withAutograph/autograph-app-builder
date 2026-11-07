import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { createWorkflowAdapters } from "./workflow-adapter";
import { describe, expect, it } from "vitest";

const createPrivateRoot = async (prefix: string) =>
  await mkdtemp(path.join(os.tmpdir(), prefix), { mode: 0o700 });
const outputRoot = () => path.join(os.tmpdir(), `self-reproduction-${crypto.randomUUID()}`);

const withPage = async (run: (page: Page) => Promise<void>) => {
  const browser = await chromium.launch();
  try {
    await run(await browser.newPage());
  } finally {
    await browser.close();
  }
};

describe("self-reproduction default workflow adapter", () => {
  it("is self-contained and omits sides whose runtime URL is unavailable", () => {
    expect(createWorkflowAdapters({ outputRoot: outputRoot() })).toEqual({});
  });

  it("binds each supplied runtime to evaluator-owned adapters", () => {
    const adapters = createWorkflowAdapters({
      candidateUrl: "http://127.0.0.1:4173",
      outputRoot: outputRoot(),
      referenceUrl: "https://localhost:3001",
    });
    expect(adapters.reference).toBeDefined();
    expect(adapters.candidate).toBeDefined();
  });

  it("classifies an absent reference fixture as not-run rather than missing product functionality", async () => {
    const { reference } = createWorkflowAdapters({
      outputRoot: outputRoot(),
      referenceUrl: "https://localhost:3001",
    });
    await withPage(async (page) => {
      const prepared = await reference?.prepare(page, "app-creation");
      expect(prepared).toEqual({
        disposition: "not-run",
        ready: false,
        reason: "The checked-in reference adapter has no bounded real fixture for app-creation.",
      });
    });
  });
});

describe("candidate workflow evidence boundaries", () => {
  it("preserves the microfrontend base path when opening the candidate", async () => {
    const { candidate } = createWorkflowAdapters({
      candidateUrl: "https://candidate.example/replica/",
      outputRoot: outputRoot(),
    });
    await withPage(async (page) => {
      const response = await candidate?.prepare(page, "documentation");
      expect(response).toEqual({
        disposition: "infrastructure-unavailable",
        ready: false,
        reason: "Candidate runtime did not answer at https://candidate.example/replica/.",
      });
    });
  });

  it.each(["authentication", "durable-draft", "app-creation", "independent-child"] as const)(
    "leaves %s unassessed when its candidate fixture is unavailable",
    async (workflow) => {
      const { candidate } = createWorkflowAdapters({
        candidateUrl: "https://candidate.example/replica/",
        outputRoot: outputRoot(),
      });
      await withPage(async (page) => {
        expect(await candidate?.prepare(page, workflow)).toMatchObject({
          disposition: "not-run",
          ready: false,
        });
      });
    },
  );

  it("prepares the real reference authentication fixture without pre-crediting assertions", async () => {
    const { reference } = createWorkflowAdapters({
      outputRoot: outputRoot(),
      referenceUrl: "https://localhost:3001",
    });
    await withPage(async (page) => {
      await expect(reference?.prepare(page, "authentication")).resolves.toMatchObject({
        ready: true,
      });
    });
  });
});

it("blocks authentication when the evaluator passkey fixture cannot be configured", async () => {
  const missingFixtureRoot = path.join(os.tmpdir(), `missing-fixture-${crypto.randomUUID()}`);
  const { reference } = createWorkflowAdapters({
    outputRoot: outputRoot(),
    referenceFixtureRoot: missingFixtureRoot,
    referenceUrl: "https://localhost:3001",
  });
  await withPage(async (page) => {
    await expect(reference?.prepare(page, "authentication")).resolves.toMatchObject({
      disposition: "infrastructure-unavailable",
      ready: false,
    });
  });
});

it("reads the isolated reference fixture flag secret", async () => {
  const fixtureRoot = await createPrivateRoot("isolated-reference-");
  try {
    const emulateRoot = path.join(fixtureRoot, ".emulate");
    await mkdir(emulateRoot);
    await writeFile(path.join(emulateRoot, "flags-secret"), "local-test-secret");
    const { reference } = createWorkflowAdapters({
      outputRoot: outputRoot(),
      referenceFixtureRoot: fixtureRoot,
      referenceUrl: "https://localhost:3001",
    });
    await withPage(async (page) => {
      const prepared = await reference?.prepare(page, "authentication");
      expect(prepared).toMatchObject({ ready: true });
    });
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

it("binds the real reference provider denial and replay fixture", async () => {
  const { reference } = createWorkflowAdapters({
    outputRoot: outputRoot(),
    referenceUrl: "https://localhost:3001",
  });
  await withPage(async (page) => {
    expect(await reference?.prepare(page, "provider-return-error")).toEqual({
      ready: true,
    });
  });
});
