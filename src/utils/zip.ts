import path from "node:path";

/**
 * Safely sanitizes a zip entry name by normalizing separators, removing leading slashes,
 * and rejecting path traversal (e.g. `..`).
 * @param entryName The entry name from the zip archive
 * @returns The sanitized safe relative path, or null if invalid or unsafe
 */
export function sanitizeZipEntryPath(entryName: string): string | null {
  const normalized = entryName.replace(/\\/g, "/");
  const posixNormalized = path.posix.normalize(normalized);
  const cleanPath = posixNormalized.replace(/^\/+/, "");

  if (
    !cleanPath ||
    cleanPath === "." ||
    cleanPath.startsWith("../") ||
    cleanPath === ".." ||
    cleanPath.split("/").includes("..")
  ) {
    return null;
  }

  return cleanPath;
}
