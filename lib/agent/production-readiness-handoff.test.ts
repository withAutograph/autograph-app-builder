import { describe, expect, it, vi } from "vitest";

import type { AppDescription } from "@/lib/repository/app-description";
import type { ProductBehaviorEvidence } from "./product-behavior-state";
import { productionReadinessHandoff } from "./production-readiness-handoff";

const root = "/workspace/repository";
const app = "spend-review";
const release = "2026-09-29.production-pilot-v13";
const description: AppDescription = {
  app: { id: app, routes: [`/${app}`], workspacePath: `apps/${app}` },
  backend: {
    authorization: "declared-policy",
    kind: "generated-postgres",
    release: {
      artifactHash: `sha256:${"a".repeat(64)}`,
      directory: `apps/${app}/schema/release/${release}`,
      id: release,
    },
    roles: ["requester", "reviewer"],
    runtime: { databaseEnvironment: "SPEND_REVIEW_DATABASE_URL" },
    schemaReceipt: { contract: "authenticated-release-read", path: "/api/schema" },
  },
  validation: {
    browser: { task: `mise //apps/${app}:test-e2e` },
    check: { task: `mise run app:check ${app}` },
    test: { shards: 3, task: `mise run app:test ${app} <shard>` },
  },
  version: 1,
};

const source = (stdout = JSON.stringify(description), exitCode = 0) => ({
  readTextFile: vi.fn().mockRejectedValue(new Error("No metadata file exists")),
  run: vi.fn().mockResolvedValue({ exitCode, stderr: "", stdout }),
});

const handoff = async (selectedSource = source()) =>
  await productionReadinessHandoff({ appId: app, repositoryRoot: root, source: selectedSource });

describe("productionReadinessHandoff", () => {
  it("uses the repository descriptor without requiring a handoff metadata file", async () => {
    const selectedSource = source();
    const result = await handoff(selectedSource);
    expect(selectedSource.run).toHaveBeenCalledWith({
      command: `mise run app:describe ${app}`,
      workingDirectory: root,
    });
    expect(selectedSource.readTextFile).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      appId: app,
      blockers: [],
      checkedRelease: { artifactHash: `sha256:${"a".repeat(64)}`, releaseId: release },
      roles: ["requester", "reviewer"],
      route: `/${app}`,
      schemaReceiptPath: "/api/schema",
      status: "operator-review-required",
    });
  });

  it("does not infer database installation, authenticated receipt behavior or product behavior from source", async () => {
    const result = await handoff();
    expect(result.evidence.installedRelease.status).toBe("unassessed");
    expect(result.evidence.authenticatedSchemaReceipt.status).toBe("unassessed");
    expect(result.evidence.behavior).toMatchObject({ coverage: "unassessed", results: [] });
    expect(result.evidence.behavior.unassessed).toContain("tenant-isolation");
    expect(result.evidence.behavior.unassessed).toContain("restart-durability");
    expect(result.operatorChecklist.accessGrants).toMatchObject({
      appId: app,
      authorization: "declared-policy",
      declaredRoles: ["requester", "reviewer"],
      status: "unassessed",
    });
    expect(result.operatorChecklist.configuration).toMatchObject({
      databaseEnvironment: "SPEND_REVIEW_DATABASE_URL",
      routes: [`/${app}`],
      status: "unassessed",
    });
    expect(result.operatorChecklist.migration).toMatchObject({
      observedInstallation: null,
      selectedRelease:
        description.backend.kind === "generated-postgres" ? description.backend.release : null,
      status: "unassessed",
    });
    expect(result.operatorChecklist.backupRecovery.status).toBe("unassessed");
    expect(result.operatorChecklist.nativeInstallerIsolation.status).toBe("blocked");
    expect(result.operatorChecklist.approvals.required).toEqual([
      { effect: "hosted-preparation", status: "unassessed" },
      { effect: "access-grants", status: "unassessed" },
      { effect: "provider-activation", status: "unassessed" },
      { effect: "recovery-or-cleanup", status: "unassessed" },
    ]);
  });

  it.each([
    {
      appId: app,
      artifactHash: "a".repeat(64),
      expected: "passed",
      releaseId: release,
    },
    {
      appId: "other-app",
      artifactHash: "a".repeat(64),
      expected: "unassessed",
      releaseId: release,
    },
    { appId: app, artifactHash: "different", expected: "unassessed", releaseId: release },
    {
      appId: app,
      artifactHash: "a".repeat(64),
      expected: "unassessed",
      releaseId: "predecessor",
    },
  ])(
    "retains only fresh installation proof matching this selected app and release",
    async (value) => {
      const result = await productionReadinessHandoff({
        appId: app,
        installationProof: {
          actors: 8,
          appId: value.appId,
          artifactHash: value.artifactHash,
          authenticatedBehavior: "unassessed",
          branch: "app-builder/inventory",
          environment: "preview",
          observation: "database-verification",
          observedAt: "2026-09-29T20:00:00.000Z",
          releaseId: value.releaseId,
          tenants: 2,
        },
        repositoryRoot: root,
        source: source(),
      });
      expect(result.evidence.installedRelease.status).toBe(value.expected);
      expect(result.evidence.authenticatedSchemaReceipt.status).toBe("unassessed");
      expect(result.evidence.behavior.coverage).toBe("unassessed");
      expect(result.operatorChecklist.migration.status).toBe("unassessed");
      expect(result.operatorChecklist.migration.observedInstallation?.environment ?? null).toBe(
        value.expected === "passed" ? "preview" : null,
      );
      expect(result.operatorChecklist.accessGrants.status).toBe("unassessed");
      expect(result.operatorChecklist.configuration.status).toBe("unassessed");
      expect(result.operatorChecklist.backupRecovery.status).toBe("unassessed");
      expect(result.operatorChecklist.nativeInstallerIsolation.status).toBe("blocked");
      expect(result.operatorChecklist.approvals.status).toBe("unassessed");
    },
  );

  it("retains actual action-readback results without expanding their coverage", async () => {
    const evidence: ProductBehaviorEvidence = {
      acceptedOutcomeText: "Submit and read a request",
      appSpecDigest: "app-spec-digest",
      applyDigest: "apply-digest",
      observedAt: "2026-09-29T20:00:00.000Z",
      result: {
        coverage: "action-readback-only",
        outcomeId: "submit-request",
        reason: "Independent application read returned the verifier-written value.",
        status: "passed",
        unassessed: ["authentication", "tenant-isolation", "restart-durability"],
      },
    };
    const result = await productionReadinessHandoff({
      appId: app,
      productBehaviorEvidence: [evidence],
      repositoryRoot: root,
      source: source(),
    });
    expect(result.evidence.behavior).toMatchObject({
      coverage: "action-readback-only",
      results: [evidence],
    });
    expect(result.evidence.installedRelease.status).toBe("unassessed");
    expect(result.evidence.authenticatedSchemaReceipt.status).toBe("unassessed");
    expect(result.evidence.behavior.unassessed).toContain("authentication");
  });

  it("reports static source without inventing a missing database release prerequisite", async () => {
    const result = await handoff(
      source(JSON.stringify({ ...description, backend: { kind: "static" } })),
    );
    expect(result.blockers).toEqual([]);
    expect(result.checkedRelease).toBeNull();
    expect(result.roles).toEqual([]);
    expect(result.evidence.installedRelease.status).toBe("not-applicable");
    expect(result.evidence.authenticatedSchemaReceipt.status).toBe("not-applicable");
    expect(result.evidence.behavior.coverage).toBe("unassessed");
    expect(result.operatorChecklist.migration).toMatchObject({
      observedInstallation: null,
      requiredEvidence: [],
      selectedRelease: null,
      status: "not-applicable",
    });
    expect(result.operatorChecklist.backupRecovery).toMatchObject({
      requiredEvidence: [],
      status: "not-applicable",
    });
    expect(result.operatorChecklist.nativeInstallerIsolation).toMatchObject({
      requiredEvidence: [],
      status: "not-applicable",
    });
    expect(result.operatorChecklist.accessGrants.status).toBe("unassessed");
    expect(result.nextSteps.join(" ")).not.toContain("selected database");
  });

  it("does not invent a route or authenticated receipt when the descriptor lacks them", async () => {
    const { backend } = description;
    if (backend.kind !== "generated-postgres") {
      throw new Error("Expected generated fixture");
    }
    const result = await handoff(
      source(
        JSON.stringify({
          ...description,
          app: { ...description.app, routes: [] },
          backend: { ...backend, schemaReceipt: null },
        }),
      ),
    );
    expect(result.route).toBeNull();
    expect(result.routes).toEqual([]);
    expect(result.schemaReceiptPath).toBeNull();
    expect(result.evidence.authenticatedSchemaReceipt.status).toBe("unassessed");
  });

  it("keeps a failed descriptor command as a concrete handoff blocker", async () => {
    const result = await handoff(source("{}", 1));
    expect(result.description).toBeNull();
    expect(result.checkedRelease).toBeNull();
    expect(result.blockers).toEqual([
      "The repository's app:describe command could not describe the selected app: The selected repository could not describe this app. Repair its app:describe command and retry.",
    ]);
  });

  it.each([
    { ...description, app: { ...description.app, id: "other-app" } },
    { ...description, backend: { kind: "unsupported" } },
  ])(
    "does not treat an unrelated or malformed descriptor as this app's capabilities",
    async (value) => {
      const result = await handoff(source(JSON.stringify(value)));
      expect(result.description).toBeNull();
      expect(result.checkedRelease).toBeNull();
      expect(result.blockers).toHaveLength(1);
      expect(result.evidence.installedRelease.status).toBe("unassessed");
    },
  );

  it("keeps technical validation available when no descriptor command can be run", async () => {
    const result = await productionReadinessHandoff({
      appId: app,
      repositoryRoot: root,
      source: {},
    });
    expect(result.description).toBeNull();
    expect(result.blockers).toHaveLength(1);
    expect(result.evidence.behavior.coverage).toBe("unassessed");
    expect(result.operatorChecklist.configuration.databaseEnvironment).toBeNull();
    expect(result.operatorChecklist.accessGrants.authorization).toBeNull();
    expect(result.operatorChecklist.accessGrants.declaredRoles).toEqual([]);
    expect(result.operatorChecklist.migration.selectedRelease).toBeNull();
    expect(result.operatorChecklist.migration.status).toBe("unassessed");
    expect(result.operatorChecklist.nativeInstallerIsolation.status).toBe("unassessed");
  });

  it("propagates caller cancellation instead of turning it into a source assessment", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Cancelled validation"));
    await expect(
      productionReadinessHandoff({
        appId: app,
        repositoryRoot: root,
        signal: controller.signal,
        source: { run: vi.fn().mockRejectedValue(controller.signal.reason) },
      }),
    ).rejects.toThrow("Cancelled validation");
  });
});
