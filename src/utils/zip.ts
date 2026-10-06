import AdmZip from 'adm-zip';
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

	depthOfEntry(entryName: string): number {
		return entryName.split('/').length;
	}

	findShallowestEntry(entryName: string): AdmZip.IZipEntry | null {
		let shallowest: AdmZip.IZipEntry | null = null;
		for (const entry of this.getEntries()) {
			const depth = this.depthOfEntry(entry.entryName);
			if (
				entry.entryName === entryName &&
				(shallowest === null || depth < this.depthOfEntry(shallowest.entryName))
			) {
				shallowest = entry;
			}
		}
		return shallowest;
	}
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
