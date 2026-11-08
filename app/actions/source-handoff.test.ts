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
  kind: "application-source-candidate-v1" as const,
  uploadId: "123e4567-e89b-42d3-a456-426614174010",
  appId: "supplier-spend",
  manifestDigest: "a".repeat(64),
};
const header = { ...reference, artifactDigest: "b".repeat(64), artifactBytes: 12, chunkCount: 1 };
it("rejects caller authority fields before storage or authentication I/O", async () => {
  // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
  const readContext = vi.fn(() => Promise.resolve(globalThis.undefined));
  const actions = createSourceUploadActions(readContext);
  const malicious = { ...header, authority: { ownerUserId: "forged" } };
  await expect(actions.begin(malicious)).rejects.toThrow();
  expect(readContext).not.toHaveBeenCalled();
});
it("requires current signed-in membership on the same action service used by Next", async () => {
  // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
  const actions = createSourceUploadActions(() => Promise.resolve(globalThis.undefined));
  await expect(actions.begin(header)).rejects.toThrow("authentication_required");
});
it("does not acknowledge a source write after membership was revoked during I/O", async () => {
  let active = true;
  const rows = new Map<string, string>();
  const store = createImmutableSourceArtifactStore({
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
    get: (key) => Promise.resolve(rows.get(JSON.stringify(key))),
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
    put: (key, value) => {
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
  // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
  const actions = createSourceUploadActions(() =>
    Promise.resolve(active ? { authority, store } : undefined),
  );
  await expect(actions.begin(header)).rejects.toThrow("authentication_required");
  expect(rows.size).toBe(1);
});
