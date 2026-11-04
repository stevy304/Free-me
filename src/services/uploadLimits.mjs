export const defaultUploadLimit = 100_000_000_000;

export function formatUploadLimit(bytes) {
  if (bytes >= 1_000_000_000) return `${bytes / 1_000_000_000} GB`;
  if (bytes % 1_048_576 === 0) return `${bytes / 1_048_576} MiB`;
  return `${bytes} bytes`;
}
