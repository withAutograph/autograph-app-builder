import { getHeapStatistics } from "node:v8";

// The 2-GiB old generation has additional young-generation overhead in Node 24.
const maximumHeapLimit = (2048 + 256) * 1024 ** 2;
const heapLimit = getHeapStatistics().heap_size_limit;
if (!Number.isSafeInteger(heapLimit) || heapLimit <= 0 || heapLimit > maximumHeapLimit) {
  throw new Error(
    "Hosted Eve build Node options exceed the reviewed 2-GiB heap budget. Remove conflicting Node heap options before retrying the build.",
  );
}
