import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';
import { SafeAdmZip, sanitizeZipEntryPath } from '../../src/utils/zip.js';

// Helper function to create an AdmZip instance from a set of files
// eslint-disable-next-line jsdoc/require-jsdoc
function createZip(files: Record<string, Buffer>): AdmZip {
	const zip = new AdmZip();
	for (const [name, content] of Object.entries(files)) {
		zip.addFile(name, content);
	}
	return zip;
}

describe('SafeAdmZip', () => {
	describe('getEntries', () => {
		it('should return sanitized entries and skip invalid ones', () => {
			const zip = createZip({
				'index.html': Buffer.from('<html></html>'),
				'assets/main.css': Buffer.from('body {}'),
				'nested/dir/app.js': Buffer.from('console.log("Hello");'),
				// Paths that need sanitization (normalized by AdmZip first)
				'assets\\style.css': Buffer.from('body {}'),
				'/index.htm': Buffer.from('<html></html>'),
				'///assets/page.css': Buffer.from('body {}'),
				'./assets/./app.css': Buffer.from('body {}')
			});

			const safeZip = new SafeAdmZip(zip);
			const skippedEntries: string[] = [];
			const safeEntries = safeZip.getEntries((skipped) => {
				skippedEntries.push(skipped.entryName);
			});
			expect(safeEntries.map((e) => e.entryName)).toEqual([
				'index.html',
				'assets/main.css',
				'nested/dir/app.js',
				'assets/style.css',
				'index.htm',
				'assets/page.css',
				'assets/app.css'
			]);
			expect(skippedEntries).toEqual([]);
		});
	});

	describe('findShallowestEntry', () => {
		it('should return the shallowest entry matching the given name', () => {
			const zip = createZip({
				'assets/main.css': Buffer.from('body {}'),
				'assets/style.css': Buffer.from('body {}'),
				'nested/index.html': Buffer.from('<html></html>'),
				'nested/dir/index.html': Buffer.from('<html></html>')
			});
			const safeZip = new SafeAdmZip(zip);
			const shallowest = safeZip.findShallowestEntry('**/*.html');
			expect(shallowest).not.toBeNull();
			expect(shallowest?.entryName).toBe('nested/index.html');
		});
	});
});

describe('sanitizeZipEntryPath', () => {
	it('preserves valid relative paths and normalizes backslashes and leading slashes', () => {
		expect(sanitizeZipEntryPath('index.html')).toBe('index.html');
		expect(sanitizeZipEntryPath('assets/main.css')).toBe('assets/main.css');
		expect(sanitizeZipEntryPath('nested/dir/app.js')).toBe('nested/dir/app.js');
		expect(sanitizeZipEntryPath('assets\\style.css')).toBe('assets/style.css');
		expect(sanitizeZipEntryPath('/index.html')).toBe('index.html');
		expect(sanitizeZipEntryPath('///assets/style.css')).toBe('assets/style.css');
		expect(sanitizeZipEntryPath('./assets/./style.css')).toBe('assets/style.css');
	});

	it('returns null for path traversal or invalid paths', () => {
		expect(sanitizeZipEntryPath('..')).toBeNull();
		expect(sanitizeZipEntryPath('../index.html')).toBeNull();
		expect(sanitizeZipEntryPath('../../etc/passwd')).toBeNull();
		expect(sanitizeZipEntryPath('nested/../../etc/passwd')).toBeNull();
		expect(sanitizeZipEntryPath('.')).toBeNull();
		expect(sanitizeZipEntryPath('')).toBeNull();
		expect(sanitizeZipEntryPath('///')).toBeNull();
	});
});
