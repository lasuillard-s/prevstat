import { describe, expect, it, vi } from 'vitest';
import { Repo } from '../../src/lib/github.js';

describe('Repo', () => {
	it('toFullName returns owner/repo format', () => {
		expect(new Repo('owner', 'repo').toFullName()).toBe('owner/repo');
	});

	it('fromFullName parses owner/repo', () => {
		expect(Repo.fromFullName('owner/repo')).toEqual(new Repo('owner', 'repo'));
	});

	it('equals compares owner and repo', () => {
		expect(new Repo('owner', 'repo').equals(new Repo('owner', 'repo'))).toBe(true);
		expect(new Repo('owner', 'repo').equals(new Repo('other', 'repo'))).toBe(false);
		expect(new Repo('owner', 'repo').equals(new Repo('owner', 'other'))).toBe(false);
	});
});

describe('downloadArtifact', () => {
	it('downloads and returns artifact zip buffer on success', async () => {
		const { downloadArtifact } = await import('../../src/lib/github.js');
		const mockOctokit = {
			rest: {
				actions: {
					downloadArtifact: vi.fn().mockResolvedValue({
						data: new Uint8Array([1, 2, 3]).buffer
					})
				}
			}
		};

		const result = await downloadArtifact(mockOctokit as never, 'owner', 'repo', 101);

		expect(result).toEqual(Buffer.from([1, 2, 3]));
	});

	it('throws error on failure', async () => {
		const { downloadArtifact } = await import('../../src/lib/github.js');
		const mockOctokit = {
			rest: {
				actions: {
					downloadArtifact: vi.fn().mockRejectedValue(new Error('Network error'))
				}
			}
		};

		await expect(downloadArtifact(mockOctokit as never, 'owner', 'repo', 101)).rejects.toThrow(
			'Network error'
		);
	});
});

describe('sanitizeZipEntryPath', () => {
	it('preserves valid relative paths and normalizes backslashes and leading slashes', async () => {
		const { sanitizeZipEntryPath } = await import('../../src/lib/github.js');

		expect(sanitizeZipEntryPath('index.html')).toBe('index.html');
		expect(sanitizeZipEntryPath('assets/main.css')).toBe('assets/main.css');
		expect(sanitizeZipEntryPath('nested/dir/app.js')).toBe('nested/dir/app.js');
		expect(sanitizeZipEntryPath('assets\\style.css')).toBe('assets/style.css');
		expect(sanitizeZipEntryPath('/index.html')).toBe('index.html');
		expect(sanitizeZipEntryPath('///assets/style.css')).toBe('assets/style.css');
		expect(sanitizeZipEntryPath('./assets/./style.css')).toBe('assets/style.css');
	});

	it('returns null for path traversal or invalid paths', async () => {
		const { sanitizeZipEntryPath } = await import('../../src/lib/github.js');

		expect(sanitizeZipEntryPath('..')).toBeNull();
		expect(sanitizeZipEntryPath('../index.html')).toBeNull();
		expect(sanitizeZipEntryPath('../../etc/passwd')).toBeNull();
		expect(sanitizeZipEntryPath('nested/../../etc/passwd')).toBeNull();
		expect(sanitizeZipEntryPath('.')).toBeNull();
		expect(sanitizeZipEntryPath('')).toBeNull();
		expect(sanitizeZipEntryPath('///')).toBeNull();
	});
});

describe('unzipAndUpload', () => {
	const mockConfig = {
		S3_BUCKET_NAME: 'test-bucket'
	};

	it('uploads valid files and skips unsafe/traversal entries', async () => {
		const { unzipAndUpload } = await import('../../src/lib/github.js');
		const AdmZip = (await import('adm-zip')).default;
		const zip = new AdmZip();
		zip.addFile('index.html', Buffer.from('hello'));
		zip.addFile('assets\\app.js', Buffer.from('console.log(1)'));
		zip.addFile('evil.html', Buffer.from('evil'));
		const entries = zip.getEntries();
		entries[2].entryName = '../../evil.html';
		const zipBuffer = zip.toBuffer();

		const mockS3Client = {
			send: vi.fn().mockResolvedValue({})
		};
		const mockLog = {
			warn: vi.fn(),
			info: vi.fn(),
			error: vi.fn(),
			debug: vi.fn()
		};

		await unzipAndUpload(
			zipBuffer,
			'my-artifact',
			'private',
			'owner',
			'repo',
			123,
			mockConfig as never,
			mockS3Client as never,
			mockLog as never
		);

		expect(mockLog.warn).toHaveBeenCalledWith(
			expect.stringContaining('Skipping unsafe or invalid zip entry path: "../../evil.html"')
		);

		expect(mockS3Client.send).toHaveBeenCalledTimes(2);
		expect(mockS3Client.send).toHaveBeenCalledWith(
			expect.objectContaining({
				input: expect.objectContaining({
					Key: 'private/owner/repo/123/my-artifact/index.html'
				})
			})
		);
		expect(mockS3Client.send).toHaveBeenCalledWith(
			expect.objectContaining({
				input: expect.objectContaining({
					Key: 'private/owner/repo/123/my-artifact/assets/app.js'
				})
			})
		);
	});

	it('throws if buffer is not a valid zip', async () => {
		const { unzipAndUpload } = await import('../../src/lib/github.js');
		const mockS3Client = { send: vi.fn() };
		const mockLog = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };

		await expect(
			unzipAndUpload(
				Buffer.from('not-a-zip'),
				'my-artifact',
				'private',
				'owner',
				'repo',
				123,
				mockConfig as never,
				mockS3Client as never,
				mockLog as never
			)
		).rejects.toThrow();
	});

	it('throws if S3 client fails to upload a file', async () => {
		const { unzipAndUpload } = await import('../../src/lib/github.js');
		const AdmZip = (await import('adm-zip')).default;
		const zip = new AdmZip();
		zip.addFile('index.html', Buffer.from('hello'));
		const zipBuffer = zip.toBuffer();

		const mockS3Client = {
			send: vi.fn().mockRejectedValue(new Error('S3 Access Denied'))
		};
		const mockLog = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };

		await expect(
			unzipAndUpload(
				zipBuffer,
				'my-artifact',
				'private',
				'owner',
				'repo',
				123,
				mockConfig as never,
				mockS3Client as never,
				mockLog as never
			)
		).rejects.toThrow('S3 Access Denied');
	});
});
