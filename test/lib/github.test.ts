import { S3Client } from '@aws-sdk/client-s3';
import AdmZip from 'adm-zip';
import nock from 'nock';
import { Readable } from 'node:stream';
import type { Context } from 'probot';
import { ProbotOctokit } from 'probot';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactDownloader, ArtifactUploader, Repo } from '../../src/lib/github.js';

// Helper function to create an AdmZip instance from a set of files
// eslint-disable-next-line jsdoc/require-jsdoc
function createZip(files: Record<string, Buffer>): AdmZip {
	const zip = new AdmZip();
	for (const [name, content] of Object.entries(files)) {
		zip.addFile(name, content);
	}
	return zip;
}

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

	it('downloads and returns artifact readable stream on success', async () => {
		const zip = createZip({
			'index.html': Buffer.from('hello')
		});
		const mock = nock('https://api.github.com')
			.get('/repos/owner/repo/actions/artifacts/101/zip')
			.reply(200, zip.toBuffer(), { 'Content-Type': 'application/zip' });

		const downloader = new ArtifactDownloader(octokit);
		const result = await downloader.downloadStream('owner', 'repo', 101);

		expect(result).toBeInstanceOf(Readable);
		expect(mock.isDone()).toBe(true);
		expect(mock.pendingMocks()).toStrictEqual([]);
	});

	it('throws error on failure', async () => {
		const mock = nock('https://api.github.com')
			.get('/repos/owner/repo/actions/artifacts/101/zip')
			.reply(500, 'Server Error');

		const downloader = new ArtifactDownloader(octokit);
		await expect(downloader.downloadStream('owner', 'repo', 101)).rejects.toThrow();
		expect(mock.isDone()).toBe(true);
		expect(mock.pendingMocks()).toStrictEqual([]);
	});
});

describe('ArtifactUploader', () => {
	it('uploads valid files and skips unsafe/traversal entries', async () => {
		const zip = createZip({
			'index.html': Buffer.from('hello'),
			'assets\\app.js': Buffer.from('console.log(1)'),
			'evil.html': Buffer.from('evil')
		});

		// Mark the third entry as a traversal path to simulate an unsafe entry
		zip.getEntries()[2].entryName = '../../evil.html';

		const mockS3Client = new S3Client({ region: 'us-east-1' });
		vi.spyOn(mockS3Client, 'send').mockResolvedValue({} as never);

		const zipStream = Readable.from(zip.toBuffer());
		const uploader = new ArtifactUploader(mockS3Client as never, 'test-bucket');
		const shallowest = await uploader.upload(zipStream, {
			owner: 'owner',
			repo: 'repo',
			workflowRunId: 123,
			artifactName: 'my-artifact',
			visibility: 'private'
		});

		expect(shallowest).toBe('index.html');
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

	it('returns the shallowest index.html path from the uploaded files', async () => {
		const zipStream = Readable.from(
			createZip({
				'deep/nested/index.html': Buffer.from('hello'),
				'shallow/index.html': Buffer.from('hello'),
				'very/deep/nested/dir/index.html': Buffer.from('hello')
			}).toBuffer()
		);

		const mockS3Client = new S3Client({ region: 'us-east-1' });
		vi.spyOn(mockS3Client, 'send').mockResolvedValue({} as never);

		const uploader = new ArtifactUploader(mockS3Client as never, 'test-bucket');
		const shallowest = await uploader.upload(zipStream, {
			owner: 'owner',
			repo: 'repo',
			workflowRunId: 123,
			artifactName: 'my-artifact',
			visibility: 'private'
		});

		expect(shallowest).toBe('shallow/index.html');
	});

	it('supports dot-prefixed paths when finding shallowest index.html', async () => {
		const zipStream = Readable.from(
			createZip({
				'.hidden/index.html': Buffer.from('hello'),
				'assets/main.css': Buffer.from('body {}')
			}).toBuffer()
		);

		const mockS3Client = new S3Client({ region: 'us-east-1' });
		vi.spyOn(mockS3Client, 'send').mockResolvedValue({} as never);

		const uploader = new ArtifactUploader(mockS3Client as never, 'test-bucket');
		const shallowest = await uploader.upload(zipStream, {
			owner: 'owner',
			repo: 'repo',
			workflowRunId: 123,
			artifactName: 'my-artifact',
			visibility: 'private'
		});

		expect(shallowest).toBe('.hidden/index.html');
	});

	it('throws if S3 client fails to upload a file', async () => {
		const zipStream = Readable.from(
			createZip({
				'index.html': Buffer.from('hello')
			}).toBuffer()
		);
		const mockS3Client = new S3Client({ region: 'us-east-1' });
		vi.spyOn(mockS3Client, 'send').mockRejectedValue(new Error('S3 Access Denied'));

		const uploader = new ArtifactUploader(mockS3Client as never, 'test-bucket');

		await expect(
			uploader.upload(zipStream, {
				owner: 'owner',
				repo: 'repo',
				workflowRunId: 123,
				artifactName: 'my-artifact',
				visibility: 'private'
			})
		).rejects.toThrow('S3 Access Denied');
	});

	it('aborts upload and throws when the download stream emits an error mid-stream', async () => {
		const zipBuffer = createZip({ 'index.html': Buffer.from('hello') }).toBuffer();

		const faultyStream = new Readable({
			read() {
				this.push(zipBuffer.subarray(0, 10)); // push incomplete data
				this.destroy(new Error('Network failure'));
			}
		});

		const mockS3Client = new S3Client({ region: 'us-east-1' });
		vi.spyOn(mockS3Client, 'send').mockResolvedValue({} as never);

		const uploader = new ArtifactUploader(mockS3Client as never, 'test-bucket');

		await expect(
			uploader.upload(faultyStream, {
				owner: 'owner',
				repo: 'repo',
				workflowRunId: 123,
				artifactName: 'my-artifact',
				visibility: 'private'
			})
		).rejects.toThrow('Network failure');
	});
});
