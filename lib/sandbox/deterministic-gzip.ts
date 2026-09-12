import { gzipSync } from "fflate";

/** Pure-JavaScript gzip keeps artifact bytes independent of host zlib builds. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function deterministicGzip(content: Uint8Array): Uint8Array {
  return gzipSync(content, { level: 9, mtime: 0 });
}
