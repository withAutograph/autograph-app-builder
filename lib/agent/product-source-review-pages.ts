/* oxlint-disable sonarjs/too-many-break-or-continue-in-loop, react-doctor/async-await-in-loop -- Source streams and files are consumed sequentially. */
import { createHash } from "node:crypto";
import type { SandboxSession } from "eve/sandbox";
import type { OverlaySnapshot } from "../repository/target-apply";

/** A bounded model page, located in a digest-verified source file. */
export interface ProductReviewSourcePage {
  path: string;
  content: string;
  startLine: number;
  startColumn: number;
}

const pageCharacters = 16 * 1024;

interface ProductReviewPageSource {
  pages: AsyncIterable<ProductReviewSourcePage>;
  omissions: string[];
}

/** Stream selected source through model pages without an aggregate repository ceiling. */
export const readProductReviewSourcePages = (input: {
  sandbox: Pick<SandboxSession, "readFile">;
  applyRoot: string;
  observed: OverlaySnapshot;
  changedPaths: string[];
}): ProductReviewPageSource => {
  const omissions = [
    "Source selection covers files changed in the current checkout; unchanged app files and imported dependencies are not traversed and cannot establish absence of functionality.",
    "Only original request text and textual clarifications are retained; attached assets are not reviewed.",
  ];
  const changedPaths = new Set(input.changedPaths);
  const selected = input.observed.files.filter((file) => changedPaths.has(file.path));
  const pages = async function* pages(): AsyncGenerator<ProductReviewSourcePage> {
    for (const file of selected) {
      if (
        !/\.(?:[cm]?[jt]sx?|json|css|sql|cue)$/u.test(file.path) ||
        /(?:^|\/)(?:node_modules|\.next|dist|coverage)(?:\/|$)/u.test(file.path)
      ) {
        omissions.push(`${file.path}: non-source or runtime artifact`);
        continue;
      }
      const path = `${input.applyRoot.replace(/^\/workspace\//u, "")}/${file.path}`;
      // oxlint-disable-next-line eslint/no-await-in-loop -- Files are streamed in order to bound live memory.
      const stream = await input.sandbox.readFile({ path });
      if (stream === null) {
        omissions.push(`${file.path}: unavailable`);
        continue;
      }
      const reader = stream.getReader();
      const digest = createHash("sha256");
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let content = "";
      let line = 1;
      let column = 1;
      let startLine = 1;
      let startColumn = 1;
      let readAny = false;
      const append = async function* append(
        decoded: string,
      ): AsyncGenerator<ProductReviewSourcePage> {
        let offset = 0;
        while (offset < decoded.length) {
          let end = Math.min(decoded.length, offset + pageCharacters - content.length);
          // Keep a surrogate pair in the same model page.
          if (
            end < decoded.length &&
            end > offset &&
            /[\uD800-\uDBFF]/u.test(decoded[end - 1] ?? "") &&
            /[\uDC00-\uDFFF]/u.test(decoded[end] ?? "")
          ) {
            end -= 1;
          }
          if (end === offset) {
            yield { content, path: file.path, startColumn, startLine };
            content = "";
            startLine = line;
            startColumn = column;
            continue;
          }
          const part = decoded.slice(offset, end);
          content += part;
          for (const character of part) {
            if (character === "\n") {
              line += 1;
              column = 1;
            } else {
              column += character.length;
            }
          }
          offset = end;
          if (content.length >= pageCharacters) {
            yield { content, path: file.path, startColumn, startLine };
            content = "";
            startLine = line;
            startColumn = column;
          }
        }
      };
      try {
        for (;;) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- A file stream must be consumed sequentially.
          const next = await reader.read();
          if (next.done) {
            break;
          }
          if (!(next.value instanceof Uint8Array)) {
            throw new Error(`Source review received non-byte content at ${file.path}.`);
          }
          readAny = true;
          digest.update(next.value);
          // oxlint-disable-next-line eslint/no-await-in-loop -- Preserve source order across transport chunks.
          yield* append(decoder.decode(next.value, { stream: true }));
        }
        yield* append(decoder.decode());
        if (content.length > 0) {
          yield { content, path: file.path, startColumn, startLine };
        }
        if (digest.digest("hex") !== file.digest) {
          throw new Error(
            `Source changed during review at ${file.path}; discard its page assessments and retry.`,
          );
        }
        if (!readAny) {
          omissions.push(`${file.path}: empty source file`);
        }
      } finally {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Finish or cancel the current source stream before another file.
        await reader.cancel();
      }
    }
  };
  return { omissions, pages: pages() };
};
