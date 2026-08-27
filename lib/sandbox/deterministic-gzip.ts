import { gzipSync } from "fflate";

/** Pure-JavaScript gzip keeps artifact bytes independent of host zlib builds. */
export function deterministicGzip(content: Uint8Array): Uint8Array {
  return gzipSync(content, { level: 9, mtime: 0 });
}
