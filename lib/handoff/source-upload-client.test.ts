import { sourceCandidateReferenceSchema } from "./application-source-contract";
import { createHash, randomUUID } from "node:crypto";
import { File } from "node:buffer";
import { expect, it } from "vitest";
import { uploadApplicationSource } from "./source-upload-client";
import { createImmutableSourceArtifactStore, SourceUploadError } from "./source-artifacts";
import { builderDraftFormSchema } from "../builder-drafts/contracts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
it("uploads multiple bounded chunks, reconciles unknown completion and retains imported identity in a durable draft", async () => {
  const content = Buffer.alloc(90_000, 255);
  const path = "apps/supplier-spend/public/asset.bin";
  const artifact = {
    manifest: {
      version: 1,
      kind: "application-source-v1",
      appId: "supplier-spend",
      displayName: "An edited display name",
      sourceSessionId: "local-original",
      files: [{ path, mode: "100644", bytes: content.length, sha256: hash(content) }],
      omissions: [],
    },
    files: [{ path, contentBase64: content.toString("base64") }],
  };
  const rows = new Map<string, string>();
  const store = createImmutableSourceArtifactStore({
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
    get: (key) => Promise.resolve(rows.get(JSON.stringify(key))),
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
    put: (key, value) => {
      const id = JSON.stringify(key);
      if (rows.has(id) && rows.get(id) !== value) {
        throw new SourceUploadError("source_upload_conflict");
      }
      rows.set(id, value);
      return Promise.resolve();
    },
  });
  const authority = {
    issuer: "https://builder.example/api/auth",
    audience: "https://builder.example/mcp",
    workspaceId: "workspace",
    ownerUserId: "user",
  };
  let writes = 0;
  const id = randomUUID();
  const uploaded = await uploadApplicationSource({
    file: new File([JSON.stringify(artifact)], "app-source.json"),
    uploadIdForDigest: () => id,
    ports: {
      // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
      begin: (header) => store.begin({ authority, header }),
      put: async (input) => {
        writes += 1;
        return await store.put({ authority, ...input });
      },
      complete: async (reference) => {
        await store.complete({ authority, reference });
        throw new Error("response lost after durable completion");
      },
      // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
      status: (reference) => store.status({ authority, reference }),
    },
  });
  expect(writes).toBeGreaterThan(1);
  expect(uploaded.reference.uploadId).toBe(id);
  expect(uploaded.reference.appId).toBe("supplier-spend");
  const draft = builderDraftFormSchema.parse({
    sourceCandidate: uploaded.reference,
    appName: uploaded.displayName,
    brief: "Continue the existing app",
    buildDestination: "codex",
    connections: [],
    modelId: "openai/model",
    privateRepository: true,
    repository: "same-app",
  });
  expect(draft.appName).toBe("An edited display name");
  expect(draft.sourceCandidate?.appId).toBe("supplier-spend");
  const restored = await store.readCompleted({
    authority,
    reference: sourceCandidateReferenceSchema.parse(draft.sourceCandidate),
  });
  expect(restored?.files[0].contentBase64).toBe(artifact.files[0].contentBase64);
});
