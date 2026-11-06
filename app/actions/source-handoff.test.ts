import { expect, it, vi } from "vitest";
import { createSourceUploadActions } from "@/lib/handoff/source-upload-deployment";
import {
  createImmutableSourceArtifactStore,
  SourceUploadError,
} from "@/lib/handoff/source-artifacts";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owned",
  workspaceId: "workspace",
};
const reference = {
  appId: "supplier-spend",
  kind: "application-source-candidate-v1" as const,
  manifestDigest: "a".repeat(64),
  uploadId: "123e4567-e89b-42d3-a456-426614174010",
};
const header = { ...reference, artifactBytes: 12, artifactDigest: "b".repeat(64), chunkCount: 1 };
it("rejects caller authority fields before storage or authentication I/O", async () => {
  const readContext = vi.fn(async () => Promise.resolve(globalThis.undefined));
  const actions = createSourceUploadActions(readContext);
  const malicious = { ...header, authority: { ownerUserId: "forged" } };
  await expect(actions.begin(malicious)).rejects.toThrow();
  expect(readContext).not.toHaveBeenCalled();
});
it("requires current signed-in membership on the same action service used by Next", async () => {
  const actions = createSourceUploadActions(async () => Promise.resolve(globalThis.undefined));
  await expect(actions.begin(header)).rejects.toThrow("authentication_required");
});
it("does not acknowledge a source write after membership was revoked during I/O", async () => {
  let active = true;
  const rows = new Map<string, string>();
  const store = createImmutableSourceArtifactStore({
    get: async (key) => Promise.resolve(rows.get(JSON.stringify(key))),
    put: async (key, value) => {
      const id = JSON.stringify(key);
      const prior = rows.get(id);
      if (prior !== undefined && prior !== value) {
        throw new SourceUploadError("source_upload_conflict");
      }
      rows.set(id, value);
      active = false;
      return Promise.resolve();
    },
  });
  const actions = createSourceUploadActions(async () =>
    Promise.resolve(active ? { authority, store } : undefined),
  );
  await expect(actions.begin(header)).rejects.toThrow("authentication_required");
  expect(rows.size).toBe(1);
});
