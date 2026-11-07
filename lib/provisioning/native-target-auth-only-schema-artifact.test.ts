import { describe, expect, it, vi } from "vitest";
import { createAuthOnlySchemaArtifactReader } from "./native-target-auth-only-schema-artifact";
import type { AuthOnlySchemaArtifactBinding } from "./native-target-auth-only-schema-artifact";
import { createOperatorArtifactPublication } from "./hosted-operator-artifacts";
import type {
  OperatorArtifactContext,
  OperatorArtifactStore,
} from "./hosted-operator-artifact-store";

const context: OperatorArtifactContext = {
  authority: {
    audience: "https://builder.example/mcp",
    issuer: "https://builder.example/api/auth",
    ownerUserId: "owner",
    workspaceId: "workspace",
  },
  target: { appId: "auth-pilot", sessionId: "original-session" },
};
const planDigest = "a".repeat(64);
const targetDigest = "b".repeat(64);
const worker = { id: "auth-protected-schema-v1", sha256: "c".repeat(64) };
const content = () =>
  Buffer.from(
    JSON.stringify({
      proposal: "new-empty",
      resource: {
        database: "isolated_auth",
        migratorRole: "auth_migrator",
        runtimeRole: "auth_runtime",
      },
      schemaPlan: { planDigest, targetDigest },
    }),
  );
const binding = (): AuthOnlySchemaArtifactBinding => ({
  context: structuredClone(context),
  selection: {
    artifactRef: `_protected-operator/artifacts/auth-plan/auth-pilot/${"d".repeat(64)}`,
    installer: { reference: worker.id, sha256: worker.sha256 },
    planDigest,
    targetDigest,
  },
  worker: { ...worker },
});

describe("approved Auth-only schema artifact read", () => {
  it("uses the existing immutable publication and owner/session artifact reader", async () => {
    const chunks = new Map<string, string>();
    const key = (owned: OperatorArtifactContext, ref: string, index: number) =>
      JSON.stringify([owned, ref, index]);
    const store: OperatorArtifactStore = {
      put: async (owned, chunk) => {
        chunks.set(key(owned, chunk.artifactRef, chunk.chunkIndex), chunk.content);
      },
      read: async (owned, ref, index) => chunks.get(key(owned, ref, index)),
    };
    const publication = createOperatorArtifactPublication({
      assertCurrentOwner: async () => {},
      store,
    });
    const artifactRef = await publication.publishAuthPlan({
      content: content(),
      context,
      planDigest,
      targetDigest,
    });
    const request = binding();
    request.selection = { ...request.selection, artifactRef };
    const assertCurrentApproval = vi.fn(async () => {});
    const reader = createAuthOnlySchemaArtifactReader({
      assertCurrentApproval,
      readAuthPlan: publication.readAuthPlan,
    });
    expect(await reader.read(request)).toEqual({ artifactRef, content: content() });
    await expect(
      reader.read({
        ...request,
        context: { ...context, target: { ...context.target, sessionId: "another-session" } },
      }),
    ).rejects.toThrow("Protected operator artifact is unavailable");
    expect(assertCurrentApproval).toHaveBeenCalledWith(request);
  });

  it("does not expose artifact bytes if approval or owner is revoked during the read", async () => {
    let current = true;
    const request = binding();
    const reader = createAuthOnlySchemaArtifactReader({
      assertCurrentApproval: async () => {
        if (!current) throw new Error("approval no longer current");
      },
      readAuthPlan: async () => {
        current = false;
        return { artifactRef: request.selection.artifactRef, content: content() };
      },
    });
    await expect(reader.read(request)).rejects.toThrow("approval no longer current");
  });

  it.each(["id", "sha256"] as const)(
    "refuses a different worker %s before any artifact read",
    async (field) => {
      const request = binding();
      request.worker = { ...request.worker, [field]: "different" };
      const readAuthPlan = vi.fn();
      const reader = createAuthOnlySchemaArtifactReader({
        assertCurrentApproval: async () => {},
        readAuthPlan,
      });
      await expect(reader.read(request)).rejects.toThrow("schema_artifact_mismatch");
      expect(readAuthPlan).not.toHaveBeenCalled();
    },
  );

  it.each(["artifactRef", "planDigest", "targetDigest"] as const)(
    "refuses mismatched returned %s",
    async (field) => {
      const request = binding();
      const frame = JSON.parse(content().toString());
      if (field !== "artifactRef") {
        frame.schemaPlan[field] = "e".repeat(64);
      }
      const reader = createAuthOnlySchemaArtifactReader({
        assertCurrentApproval: async () => {},
        readAuthPlan: async () => ({
          artifactRef: field === "artifactRef" ? "another-artifact" : request.selection.artifactRef,
          content: Buffer.from(JSON.stringify(frame)),
        }),
      });
      await expect(reader.read(request)).rejects.toThrow("schema_artifact_mismatch");
    },
  );

  it("snapshots approval inputs before awaiting and returned bytes before the final authority check", async () => {
    const request = binding();
    const approved = structuredClone(request);
    const bytes = content();
    const observed: AuthOnlySchemaArtifactBinding[] = [];
    const readAuthPlan = vi.fn(async (owned, expected) => {
      expect(owned).toEqual(approved.context);
      expect(expected).toEqual({
        artifactRef: approved.selection.artifactRef,
        planDigest,
        targetDigest,
      });
      return { artifactRef: expected.artifactRef, content: bytes };
    });
    const reader = createAuthOnlySchemaArtifactReader({
      assertCurrentApproval: async (received) => {
        observed.push(structuredClone(received));
        if (observed.length === 1) {
          request.context.target.sessionId = "changed";
          request.selection = { ...request.selection, artifactRef: "changed" };
          request.worker = { id: "changed", sha256: "f".repeat(64) };
          received.context.target.appId = "changed-by-port";
          await Promise.resolve();
        } else bytes.fill(0);
      },
      readAuthPlan,
    });
    expect(await reader.read(request)).toEqual({
      artifactRef: approved.selection.artifactRef,
      content: content(),
    });
    expect(observed).toEqual([approved, approved]);
  });

  it("does not read private artifacts before authenticated approval succeeds", async () => {
    const readAuthPlan = vi.fn();
    const reader = createAuthOnlySchemaArtifactReader({
      assertCurrentApproval: async () => {
        throw new Error("approval required");
      },
      readAuthPlan,
    });
    await expect(reader.read(binding())).rejects.toThrow("approval required");
    expect(readAuthPlan).not.toHaveBeenCalled();
  });
});
