import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createImmutableSourceArtifactStore,
  SOURCE_UPLOAD_CHUNK_BYTES,
  SourceUploadError,
} from "./source-artifacts";
import type { SourceArtifactChunkKey } from "./source-artifacts";
import { validateApplicationSourceArtifact } from "./application-source-bytes";
import { withSourceUploadAuthority } from "./source-upload-deployment";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "user-one",
  workspaceId: "workspace-one",
};
const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const fixture = () => {
  const rows = new Map<string, string>();
  const key = (k: SourceArtifactChunkKey) => JSON.stringify(k);
  const store = createImmutableSourceArtifactStore({
    get: async (k) => rows.get(key(k)),
    put: async (k, v) => {
      const prior = rows.get(key(k));
      if (prior !== undefined && prior !== v) {
        throw new SourceUploadError("source_upload_conflict");
      }
      rows.set(key(k), v);
      return;
    },
  });
  const bytes = Buffer.from([0, 255, 128, 1]);
  const artifact = {
    files: [
      { contentBase64: bytes.toString("base64"), path: "apps/supplier-spend/public/logo.bin" },
    ],
    manifest: {
      appId: "supplier-spend",
      displayName: "Supplier Spend",
      files: [
        {
          bytes: bytes.length,
          mode: "100755",
          path: "apps/supplier-spend/public/logo.bin",
          sha256: hash(bytes),
        },
      ],
      kind: "application-source-v1",
      omissions: [],
      sourceSessionId: "local-source-only",
      version: 1,
    },
  };
  const valid = validateApplicationSourceArtifact(artifact);
  const payload = Buffer.from(JSON.stringify(artifact));
  const header = {
    appId: "supplier-spend",
    artifactBytes: payload.length,
    artifactDigest: hash(payload),
    chunkCount: Math.ceil(payload.length / SOURCE_UPLOAD_CHUNK_BYTES),
    kind: "application-source-candidate-v1" as const,
    manifestDigest: valid.manifestDigest,
    uploadId: randomUUID(),
  };
  const upload = async () => {
    const reference = await store.begin({ authority, header });
    await store.put({
      authority,
      chunkIndex: 0,
      contentBase64: payload.toString("base64"),
      reference,
    });
    return reference;
  };
  return { header, payload, rows, store, upload };
};
describe("owned immutable source uploads", () => {
  it("selects only verified complete source and preserves exact binary bytes/mode across retry", async () => {
    const f = fixture();
    const reference = await f.upload();
    expect(await f.store.readCompleted({ authority, reference })).toBeUndefined();
    await f.store.complete({ authority, reference });
    const before = f.rows.size;
    await f.upload();
    await f.store.complete({ authority, reference });
    expect(f.rows.size).toBe(before);
    const restored = await f.store.readCompleted({ authority, reference });
    const [restoredFile] = validateApplicationSourceArtifact(restored).files;
    expect(restoredFile.mode).toBe("100755");
    expect([...restoredFile.bytes]).toEqual([0, 255, 128, 1]);
  });
  it("keeps the request reservation fixed even when a retry declares another digest", async () => {
    const f = fixture();
    await f.store.begin({ authority, header: f.header });
    await expect(
      f.store.begin({ authority, header: { ...f.header, manifestDigest: "b".repeat(64) } }),
    ).rejects.toThrow("conflict");
  });
  it("rejects incomplete, foreign and altered data without publishing completion", async () => {
    const f = fixture();
    const reference = await f.store.begin({ authority, header: f.header });
    await expect(f.store.complete({ authority, reference })).rejects.toThrow("incomplete");
    await expect(
      f.store.readCompleted({
        authority: { ...authority, workspaceId: "workspace-two" },
        reference,
      }),
    ).rejects.toThrow("incomplete");
    const changed = Buffer.from(f.payload);
    changed[changed.length - 2] = ((changed.at(-2) ?? 0) + 1) % 256;
    await f.store.put({
      authority,
      chunkIndex: 0,
      contentBase64: changed.toString("base64"),
      reference,
    });
    await expect(f.store.complete({ authority, reference })).rejects.toThrow("invalid");
    const observed = await f.store.status({ authority, reference });
    expect(observed.status).toBe("uploading");
  });
  it("reconciles a lost completion response through same-ID owned readback", async () => {
    const f = fixture();
    const reference = await f.upload();
    await f.store.complete({ authority, reference });
    expect(await f.store.status({ authority, reference })).toEqual({
      reference,
      status: "complete",
    });
  });
  it("rechecks membership after an I/O boundary before acknowledging it", async () => {
    const f = fixture();
    let active = true;
    const context = async () => (active ? { authority, store: f.store } : undefined);
    await expect(
      withSourceUploadAuthority(context, async ({ store }) => {
        await store.begin({ authority, header: f.header });
        active = false;
      }),
    ).rejects.toThrow("authentication_required");
  });
});
