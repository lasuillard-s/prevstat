import AdmZip from 'adm-zip';
import nock from 'nock';
import type { Context } from 'probot';
import { ProbotOctokit } from 'probot';
import { describe, expect, it, vi } from 'vitest';
import {
	ArtifactDownloader,
	ArtifactUploader,
	Repo,
	sanitizeZipEntryPath
} from '../../src/lib/github.js';

describe('Repo', () => {
	it('instantiates and provides owner and repo', () => {
		const repo = new Repo('my-org', 'my-repo');
		expect(repo.owner).toBe('my-org');
		expect(repo.repo).toBe('my-repo');
		expect(repo.toString()).toBe('my-org/my-repo');
	});

	it('creates from full name', () => {
		const repo = Repo.fromFullName('my-org/my-repo');
		expect(repo.owner).toBe('my-org');
		expect(repo.repo).toBe('my-repo');
	});

	it('throws for invalid full name', () => {
		expect(() => Repo.fromFullName('invalid')).toThrow('Invalid repository full name');
	});

	it('creates from Probot Context', () => {
		const mockContext = {
			repo: () => ({ owner: 'context-org', repo: 'context-repo' })
		} as unknown as Context;
		const repo = Repo.fromContext(mockContext);
		expect(repo.owner).toBe('context-org');
		expect(repo.repo).toBe('context-repo');
	});

	it('checks equality with another Repo', () => {
		const repo1 = new Repo('owner', 'repo');
		const repo2 = new Repo('owner', 'repo');
		const repo3 = new Repo('owner', 'other-repo');
		expect(repo1.equals(repo2)).toBe(true);
		expect(repo1.equals(repo3)).toBe(false);
	});

	describe('fromUrl', () => {
		it('parses owner and repo from a complete artifact URL', () => {
			const repo = Repo.fromUrl(
				'https://assets.example.com/private/my-org/my-repo/123/build-output/index.html'
			);
			expect(repo.owner).toBe('my-org');
			expect(repo.repo).toBe('my-repo');
		});

		it('parses URL-encoded owner and repo correctly', () => {
			const repo = Repo.fromUrl(
				'https://assets.example.com/private/my%2Dorg/my%2Drepo/123/build-output/sub/dir/index.html'
			);
			expect(repo.owner).toBe('my-org');
			expect(repo.repo).toBe('my-repo');
		});

		it('throws an error for incomplete path patterns', () => {
			expect(() =>
				Repo.fromUrl('https://assets.example.com/private/my-org/my-repo/123/build-output')
			).toThrow('Incomplete artifact path in URL');

			expect(() => Repo.fromUrl('https://assets.example.com/private/my-org/my-repo/123')).toThrow(
				'Incomplete artifact path in URL'
			);

			expect(() => Repo.fromUrl('https://assets.example.com/private/my-org/my-repo')).toThrow(
				'Incomplete artifact path in URL'
			);

			expect(() => Repo.fromUrl('https://assets.example.com/private/my-org')).toThrow(
				'Incomplete artifact path in URL'
			);
		});

		it('throws an error if any required component is empty', () => {
			expect(() =>
				Repo.fromUrl('https://assets.example.com/private//my-repo/123/build-output/index.html')
			).toThrow('Missing required path components in URL');
		});

		it('throws an error for invalid URL string', () => {
			expect(() => Repo.fromUrl('invalid-url')).toThrow();
		});
	});
});

describe('ArtifactDownloader', () => {
	const octokit = new ProbotOctokit({
		auth: 'mock-token',
		retry: { enabled: false },
		throttle: { enabled: false }
	});

	it('downloads and returns artifact zip buffer on success', async () => {
		const mock = nock('https://api.github.com')
			.get('/repos/owner/repo/actions/artifacts/101/zip')
			.reply(200, Buffer.from([1, 2, 3]));

		const downloader = new ArtifactDownloader(octokit);
		const result = await downloader.download('owner', 'repo', 101);

		expect(result).toEqual(Buffer.from([1, 2, 3]));
		expect(mock.isDone()).toBe(true);
		expect(mock.pendingMocks()).toStrictEqual([]);
	});

	it('throws error on failure', async () => {
		const mock = nock('https://api.github.com')
			.get('/repos/owner/repo/actions/artifacts/101/zip')
			.reply(500, 'Server Error');

		const downloader = new ArtifactDownloader(octokit);
		await expect(downloader.download('owner', 'repo', 101)).rejects.toThrow();
		expect(mock.isDone()).toBe(true);
		expect(mock.pendingMocks()).toStrictEqual([]);
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
