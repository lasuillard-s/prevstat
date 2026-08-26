import AdmZip from 'adm-zip';
import { describe, expect, vi } from 'vitest';
import {
	ArtifactDownloader,
	ArtifactUploader,
	sanitizeZipEntryPath
} from '../../src/lib/github.js';
import { test as it } from '../helpers.js';

describe('ArtifactDownloader', () => {
	it('downloads and returns artifact zip buffer on success', async () => {
		const mockOctokit = {
			rest: {
				actions: {
					downloadArtifact: vi.fn().mockResolvedValue({
						data: new Uint8Array([1, 2, 3]).buffer
					})
				}
			}
		};

		const downloader = new ArtifactDownloader(mockOctokit as never);
		const result = await downloader.download('owner', 'repo', 101);

		expect(mockOctokit.rest.actions.downloadArtifact).toHaveBeenCalledWith({
			owner: 'owner',
			repo: 'repo',
			artifact_id: 101,
			archive_format: 'zip'
		});
		expect(result).toEqual(Buffer.from([1, 2, 3]));
	});

	it('throws error on failure', async () => {
		const mockOctokit = {
			rest: {
				actions: {
					downloadArtifact: vi.fn().mockRejectedValue(new Error('Network error'))
				}
			}
		};

		const downloader = new ArtifactDownloader(mockOctokit as never);
		await expect(downloader.download('owner', 'repo', 101)).rejects.toThrow('Network error');
	});
});

describe('ArtifactUploader', () => {
	it('uploads valid files and skips unsafe/traversal entries', async () => {
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

		const uploader = new ArtifactUploader(mockS3Client as never, 'test-bucket');
		await uploader.upload(zipBuffer, {
			owner: 'owner',
			repo: 'repo',
			workflowRunId: 123,
			artifactName: 'my-artifact',
			visibility: 'private'
		});

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
		const mockS3Client = { send: vi.fn() };

		const uploader = new ArtifactUploader(mockS3Client as never, 'test-bucket');

		await expect(
			uploader.upload(Buffer.from('not-a-zip'), {
				owner: 'owner',
				repo: 'repo',
				workflowRunId: 123,
				artifactName: 'my-artifact',
				visibility: 'private'
			})
		).rejects.toThrow();
	});

	it('throws if S3 client fails to upload a file', async () => {
		const zip = new AdmZip();
		zip.addFile('index.html', Buffer.from('hello'));
		const zipBuffer = zip.toBuffer();

		const mockS3Client = {
			send: vi.fn().mockRejectedValue(new Error('S3 Access Denied'))
		};

		const uploader = new ArtifactUploader(mockS3Client as never, 'test-bucket');
		await expect(
			uploader.upload(zipBuffer, {
				owner: 'owner',
				repo: 'repo',
				workflowRunId: 123,
				artifactName: 'my-artifact',
				visibility: 'private'
			})
		).rejects.toThrow('S3 Access Denied');
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
