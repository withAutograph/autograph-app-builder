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
    files: [{ contentBase64: content.toString("base64"), path }],
    manifest: {
      appId: "supplier-spend",
      displayName: "An edited display name",
      files: [{ bytes: content.length, mode: "100644", path, sha256: hash(content) }],
      kind: "application-source-v1",
      omissions: [],
      sourceSessionId: "local-original",
      version: 1,
    },
  };
  const rows = new Map<string, string>();
  const store = createImmutableSourceArtifactStore({
    get: async (key) => rows.get(JSON.stringify(key)),
    put: async (key, value) => {
      const id = JSON.stringify(key);
      if (rows.has(id) && rows.get(id) !== value) {
        throw new SourceUploadError("source_upload_conflict");
      }
      rows.set(id, value);
    },
  });
  const authority = {
    audience: "https://builder.example/mcp",
    issuer: "https://builder.example/api/auth",
    ownerUserId: "user",
    workspaceId: "workspace",
  };
  let writes = 0;
  const id = randomUUID();
  const uploaded = await uploadApplicationSource({
    file: new File([JSON.stringify(artifact)], "app-source.json"),
    ports: {
      begin: async (header) => await store.begin({ authority, header }),
      complete: async (reference) => {
        await store.complete({ authority, reference });
        throw new Error("response lost after durable completion");
      },
      put: async (input) => {
        writes += 1;
        return await store.put({ authority, ...input });
      },
      status: async (reference) => await store.status({ authority, reference }),
    },
    uploadIdForDigest: () => id,
  });
  expect(writes).toBeGreaterThan(1);
  expect(uploaded.reference.uploadId).toBe(id);
  expect(uploaded.reference.appId).toBe("supplier-spend");
  const draft = builderDraftFormSchema.parse({
    appName: uploaded.displayName,
    brief: "Continue the existing app",
    buildDestination: "codex",
    connections: [],
    modelId: "openai/model",
    privateRepository: true,
    repository: "same-app",
    sourceCandidate: uploaded.reference,
  });
  expect(draft.appName).toBe("An edited display name");
  expect(draft.sourceCandidate?.appId).toBe("supplier-spend");
  const restored = await store.readCompleted({
    authority,
    reference: sourceCandidateReferenceSchema.parse(draft.sourceCandidate),
  });
  expect(restored?.files[0].contentBase64).toBe(artifact.files[0].contentBase64);
});
