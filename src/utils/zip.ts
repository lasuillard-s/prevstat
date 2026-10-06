import AdmZip from 'adm-zip';
import { minimatch } from 'minimatch';
import path from 'node:path';

/**
 * A wrapper around AdmZip that provides safe handling of zip entries, preventing path traversal and other unsafe entries.
 */
export class SafeAdmZip {
	private zip: AdmZip;

	constructor(zip: AdmZip) {
		this.zip = zip;
	}

	getEntries(onSkip?: (entry: AdmZip.IZipEntry) => void): AdmZip.IZipEntry[] {
		return this.zip
			.getEntries()
			.map((entry) => {
				const sanitized = sanitizeZipEntryPath(entry.entryName);
				if (!sanitized) {
					onSkip?.(entry);
					return null;
				}
				entry.entryName = sanitized;
				return entry;
			})
			.filter((entry) => entry !== null);
	}

	findShallowestEntry(entryNamePattern: string): AdmZip.IZipEntry | null {
		let shallowest: AdmZip.IZipEntry | null = null;
		for (const entry of this.getEntries()) {
			const depth = depthOfEntry(entry.entryName);
			if (
				minimatch(entry.entryName, entryNamePattern, { dot: true }) &&
				(shallowest === null || depth < depthOfEntry(shallowest.entryName))
			) {
				shallowest = entry;
			}
		}
		return shallowest;
	}
}

/**
 * Returns the depth of a given zip entry based on the number of path segments.
 * @param entryName The name of the zip entry whose depth is to be calculated.
 * @returns The depth of the zip entry based on the number of path segments.
 */
function depthOfEntry(entryName: string): number {
	return entryName.split('/').length;
}

/**
 * Safely sanitizes a zip entry name by normalizing separators, removing leading slashes,
 * and rejecting path traversal (e.g. `..`).
 * @param entryName The entry name from the zip archive
 * @returns The sanitized safe relative path, or null if invalid or unsafe
 */
export function sanitizeZipEntryPath(entryName: string): string | null {
	const normalized = entryName.replace(/\\/g, '/');
	const posixNormalized = path.posix.normalize(normalized);
	const cleanPath = posixNormalized.replace(/^\/+/, '');

	if (
		!cleanPath ||
		cleanPath === '.' ||
		cleanPath.startsWith('../') ||
		cleanPath === '..' ||
		cleanPath.split('/').includes('..')
	) {
		return null;
	}

	return cleanPath;
}
