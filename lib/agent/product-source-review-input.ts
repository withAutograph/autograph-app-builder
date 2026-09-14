/* oxlint-disable sonarjs/too-many-break-or-continue-in-loop -- Each skipped evidence file retains a distinct omission reason. */
/* oxlint-disable react-doctor/async-await-in-loop -- Sequential reads bound provider load and model context accumulation. */
import { createHash } from "node:crypto";
import type { SandboxSession } from "eve/sandbox";
import type { OverlaySnapshot } from "../repository/target-apply";
import type { ProductSourceReviewInput } from "./product-source-review";

/** Bounded model context; omissions are evidence coverage, never a source validity gate. */
export const readProductReviewSource = async (input: {
  sandbox: Pick<SandboxSession, "readTextFile">;
  applyRoot: string;
  appId: string;
  observed: OverlaySnapshot;
  changedPaths: string[];
}): Promise<Pick<ProductSourceReviewInput, "files" | "omissions">> => {
  const files: ProductSourceReviewInput["files"] = [];
  const omissions = [
    "Source selection covers app files, changed files and root manifests; imports into unchanged shared/dependency implementations are not traversed and cannot establish absence of functionality.",
    "Only original request text and textual clarifications are retained; attached assets are not reviewed.",
  ];
  let bytes = 0;
  const prefix = `apps/${input.appId}/`;
  const changedPaths = new Set(input.changedPaths);
  const selected = input.observed.files.filter(
    (file) =>
      file.path.startsWith(prefix) ||
      changedPaths.has(file.path) ||
      ["package.json", "tsconfig.json"].includes(file.path),
  );
  for (const file of selected) {
    if (
      !/\.(?:[cm]?[jt]sx?|json|css|sql|cue)$/u.test(file.path) ||
      /(?:^|\/)(?:node_modules|\.next|dist|coverage)(?:\/|$)/u.test(file.path)
    ) {
      omissions.push(`${file.path}: non-source or runtime artifact`);
      continue;
    }
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Bound provider reads and retain explicit per-file coverage.
      const content = await input.sandbox.readTextFile({
        path: `${input.applyRoot.replace(/^\/workspace\//u, "")}/${file.path}`,
      });
      if (content === null) {
        omissions.push(`${file.path}: unavailable`);
        continue;
      }
      if (createHash("sha256").update(content).digest("hex") !== file.digest) {
        omissions.push(`${file.path}: changed during observation`);
        continue;
      }
      const fileBytes = Buffer.byteLength(content);
      if (bytes + fileBytes > 400_000) {
        omissions.push(`${file.path}: model context omitted`);
        continue;
      }
      bytes += fileBytes;
      files.push({ content, path: file.path });
    } catch {
      omissions.push(`${file.path}: unreadable`);
    }
  }
  return { files, omissions };
};
