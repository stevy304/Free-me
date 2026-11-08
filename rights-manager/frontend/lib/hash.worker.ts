/// <reference lib="webworker" />
import { createSHA256 } from "hash-wasm";

/** SHA-256 of a whole file, 8 MB at a time (constant memory, off the main thread). */
self.onmessage = async (e: MessageEvent<{ file: File }>) => {
  const { file } = e.data;
  const h = await createSHA256();
  const step = 8 * 1024 * 1024;
  for (let pos = 0; pos < file.size; pos += step) {
    h.update(new Uint8Array(await file.slice(pos, pos + step).arrayBuffer()));
    if ((pos / step) % 8 === 0) self.postMessage({ progress: pos / file.size });
  }
  self.postMessage({ sha256: h.digest("hex") });
};
