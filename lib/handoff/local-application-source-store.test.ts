import { applicationSourceArtifactSchema } from "./application-source-contract";
import { createApplicationSourceDownloadHandler } from "./application-source-download";
import { mkdtemp, writeFile, chmod, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { createLocalApplicationSourceStore } from "./local-application-source-store";

it("retains source only in its actual local cycle and exact originating session", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "source-store-")));
  await chmod(root, 0o700);
  const cycleFile = path.join(root, "cycle");
  await writeFile(cycleFile, "a".repeat(64), { mode: 0o600 });
  try {
    const environment = {
      APP_BUILDER_EXECUTION_MODE: "development",
      APP_BUILDER_EXECUTION_BUNDLE: "local-development",
      APP_BUILDER_LOCAL_ADAPTER: "1",
      EVE_HOSTED_ADAPTER: "0",
      APP_BUILDER_LOCAL_EVE_CYCLE_FILE: cycleFile,
    };
    const store = createLocalApplicationSourceStore(environment);
    const bytes = Buffer.from([0, 255]);
    const artifact = {
      manifest: {
        version: 1 as const,
        kind: "application-source-v1" as const,
        appId: "app",
        displayName: "App",
        sourceSessionId: "owner",
        files: [
          {
            path: "apps/app/image.bin",
            mode: "100644" as const,
            bytes: 2,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ],
        omissions: [],
      },
      files: [{ path: "apps/app/image.bin", contentBase64: bytes.toString("base64") }],
    };
    const saved = await store.put(artifact);
    const handler = createApplicationSourceDownloadHandler({
      ...environment,
      APP_BUILDER_DEVELOPMENT_ORIGIN: "http://127.0.0.1:3400",
    });
    const response = await handler(
      new Request(`http://127.0.0.1:3400/application-source/owner/${saved.manifestDigest}`),
      { digest: saved.manifestDigest, sessionId: "owner" },
    );
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect(
      applicationSourceArtifactSchema.parse(JSON.parse(await response.text())).manifest
        .sourceSessionId,
    ).toBe("owner");
    const foreignOrigin = await handler(
      new Request(`https://foreign.example/application-source/owner/${saved.manifestDigest}`),
      { digest: saved.manifestDigest, sessionId: "owner" },
    );
    expect(foreignOrigin.status).toBe(404);
    const observed = await store.read("owner", saved.manifestDigest);
    expect(observed.manifest.sourceSessionId).toBe("owner");
    await expect(store.read("foreign", saved.manifestDigest)).rejects.toThrow();
    await writeFile(cycleFile, "b".repeat(64), { mode: 0o600 });
    await expect(store.read("owner", saved.manifestDigest)).rejects.toThrow();
    expect(() =>
      createLocalApplicationSourceStore({ ...environment, EVE_HOSTED_ADAPTER: "1" }),
    ).toThrow();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
