import { describe, expect, it, vi } from "vitest";
import { verifyOperatorWorkerSourceCapture } from "./operator-worker-source-capture";
import { bytes, capture, worker } from "./operator-worker-source-capture.test-fixture";

describe("actual operator worker source capture", () => {
  it("matches the frozen two-repository receipt and selected binary path/hash", async () => {
    const readFile = vi.fn().mockResolvedValue(bytes);
    await verifyOperatorWorkerSourceCapture({ readFile, worker });
    expect(readFile).toHaveBeenCalledExactlyOnceWith(capture.catalogPath);
  });
  it.each(["receipt", "source", "worker", "path"])(
    "rejects mismatched %s without accepting claimed metadata",
    async (kind) => {
      const changed = structuredClone(worker);
      if (kind === "source") {
        changed.sourceCapture.sources.arrusted.sha = "f".repeat(40);
      }
      if (kind === "worker") {
        changed.sha256 = "f".repeat(64);
      }
      if (kind === "path") {
        changed.executablePath = "/trusted/legacy/bin/worker";
      }
      await expect(
        verifyOperatorWorkerSourceCapture({
          worker: changed,
          // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
          readFile: () =>
            Promise.resolve(Buffer.from(kind === "receipt" ? "wrong receipt" : bytes)),
        }),
      ).rejects.toMatchObject({ message: "operator_worker_source_capture_mismatch" });
    },
  );
  it("preserves a legacy frozen descriptor without claiming source provenance", async () => {
    const readFile = vi.fn();
    await verifyOperatorWorkerSourceCapture({
      worker: { executablePath: worker.executablePath, sha256: worker.sha256 },
      readFile,
    });
    expect(readFile).not.toHaveBeenCalled();
  });
});
