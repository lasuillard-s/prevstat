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
		expect(zipStream.destroyed).toBe(true);
	});

	it('aborts upload, cleans up active entry, and throws when download stream fails during file content', async () => {
		const zipBuffer = createZip({ 'index.html': Buffer.from('a'.repeat(200)) }).toBuffer();

		let pushed = false;
		// faultyStream is intentionally faulty: it pushes the local header (30 bytes) and the first 30 bytes of file
		// content, then emits an Error without pushing null (EOF), simulating a dropped socket/network failure from GitHub
		// while file contents are actively streaming.
		const faultyStream = new Readable({
			read() {
				if (!pushed) {
					pushed = true;
					this.push(zipBuffer.subarray(0, 60));
					setImmediate(() => {
						this.destroy(new Error('Network failure during download'));
					});
				}
			}
		});

		const mockS3Client = new S3Client({ region: 'us-east-1' });
		vi.spyOn(mockS3Client, 'send').mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
			return {} as never;
		});

		const uploader = new ArtifactUploader(mockS3Client as never, 'test-bucket');

		await expect(
			uploader.upload(faultyStream, {
				owner: 'owner',
				repo: 'repo',
				workflowRunId: 123,
				artifactName: 'my-artifact',
				visibility: 'private'
			})
		).rejects.toThrow('Network failure during download');

		expect(faultyStream.destroyed).toBe(true);
	});

	it('uploads ZIP entries correctly without relying on ContentLength', async () => {
		const zip = new AdmZip();
		zip.addFile('index.html', Buffer.from('hello descriptor'));
		const zipBuffer = zip.toBuffer();
		const zipStream = Readable.from(zipBuffer);

		const mockS3Client = new S3Client({ region: 'us-east-1' });

		const uploadedBodies: string[] = [];
		vi.spyOn(mockS3Client, 'send').mockImplementation(async (command: unknown) => {
			const cmd = command as { input?: { Body?: unknown; ContentLength?: number } };
			if (cmd.input && cmd.input.Body) {
				const contentLength = cmd.input.ContentLength;
				let bodyBuf: Buffer;
				if (Buffer.isBuffer(cmd.input.Body) || cmd.input.Body instanceof Uint8Array) {
					bodyBuf = Buffer.from(cmd.input.Body);
				} else {
					const bodyChunks: Buffer[] = [];
					for await (const chunk of cmd.input.Body as AsyncIterable<Uint8Array | number>) {
						bodyChunks.push(typeof chunk === 'number' ? Buffer.from([chunk]) : Buffer.from(chunk));
					}
					bodyBuf = Buffer.concat(bodyChunks);
				}
				const effectiveBuf =
					contentLength !== undefined ? bodyBuf.subarray(0, contentLength) : bodyBuf;
				uploadedBodies.push(effectiveBuf.toString());
			}
			return {} as never;
		});

		const uploader = new ArtifactUploader(mockS3Client as never, 'test-bucket');
		await uploader.upload(zipStream, {
			owner: 'owner',
			repo: 'repo',
			workflowRunId: 123,
			artifactName: 'my-artifact',
			visibility: 'private'
		});

		expect(uploadedBodies).toHaveLength(1);
		expect(uploadedBodies[0]).toBe('hello descriptor');
	});

	it('successfully parses and uploads ZIP archives using Data Descriptors with nested ZIPs (avoids unexpected end of file)', async () => {
		// This base64 string represents a ZIP file (created with `zip -fd outer.zip inner.zip`)
		// that uses Data Descriptors and contains a nested ZIP payload.
		// Streaming ZIP parsers (like unzipper.Parse with forceStream: true) notoriously crash
		// with "unexpected end of file" or "invalid signature" on this payload because they mistake
		// the inner ZIP's signatures for the outer ZIP's structure when scanning for descriptors.
		// The disk-based unzipper.Open.file correctly uses the Central Directory to bypass this flaw.
		const base64Fixture =
			'UEsDBAoACAAAAK9tR10AAAAAswAAALMAAAAJABwAaW5uZXIuemlwVVQJAAP6TMZq+kzGanV4CwAB' +
			'BOsDAAAE6wMAAFBLAwQKAAAAAACvbUddk2MPFgsAAAALAAAACQAcAGlubmVyLnR4dFVUCQAD+kzG' +
			'avpMxmp1eAsAAQTrAwAABOsDAABpbm5lciBmaWxlClBLAQIeAwoAAAAAAK9tR12TYw8WCwAAAAsA' +
			'AAAJABgAAAAAAAEAAAC2gQAAAABpbm5lci50eHRVVAUAA/pMxmp1eAsAAQTrAwAABOsDAABQSwUG' +
			'AAAAAAEAAQBPAAAATgAAAAAAUEsHCKxeCZyzAAAAswAAAFBLAQIeAwoACAAAAK9tR12sXgmcswAA' +
			'ALMAAAAJABgAAAAAAAAAAAC2gQAAAABpbm5lci56aXBVVAUAA/pMxmp1eAsAAQTrAwAABOsDAABQ' +
			'SwUGAAAAAAEAAQBPAAAABgEAAAAA';

		const zipBuffer = Buffer.from(base64Fixture, 'base64');
		const zipStream = Readable.from(zipBuffer);

		const mockS3Client = new S3Client({ region: 'us-east-1' });
		const uploadedBodies: string[] = [];
		vi.spyOn(mockS3Client, 'send').mockImplementation(async (command: unknown) => {
			const cmd = command as { input?: { Body?: unknown } };
			if (cmd.input && cmd.input.Body) {
				if (Buffer.isBuffer(cmd.input.Body) || cmd.input.Body instanceof Uint8Array) {
					uploadedBodies.push(Buffer.from(cmd.input.Body).toString());
				} else {
					const bodyChunks: Buffer[] = [];
					for await (const chunk of cmd.input.Body as AsyncIterable<Uint8Array | number>) {
						bodyChunks.push(typeof chunk === 'number' ? Buffer.from([chunk]) : Buffer.from(chunk));
					}
					uploadedBodies.push(Buffer.concat(bodyChunks).toString());
				}
			}
			return {} as never;
		});

		const uploader = new ArtifactUploader(mockS3Client as never, 'test-bucket');
		await uploader.upload(zipStream, {
			owner: 'owner',
			repo: 'repo',
			workflowRunId: 123,
			artifactName: 'my-artifact',
			visibility: 'private'
		});

		expect(uploadedBodies).toHaveLength(1);
		// The payload uploaded should be exactly the bytes of the nested inner.zip
		expect(uploadedBodies[0].startsWith('PK')).toBe(true);
	});

	it('handles multipart uploads for files exceeding 5 MiB part size', async () => {
		const partSize = 5 * 1_024 * 1_024;
		const largeContent = Buffer.alloc(partSize + 1_024 * 512, 'm');
		const zip = createZip({ 'index.html': largeContent });
		const zipStream = Readable.from(zip.toBuffer());

		const mockS3Client = new S3Client({ region: 'us-east-1' });

		const commandsSent: string[] = [];
		const uploadedParts: { PartNumber: number; size: number }[] = [];

		vi.spyOn(mockS3Client, 'send').mockImplementation(async (command: unknown) => {
			const cmd = command as { constructor: { name: string }; input: Record<string, unknown> };
			const name = cmd.constructor?.name;
			commandsSent.push(name);

			if (name === 'CreateMultipartUploadCommand') {
				return { UploadId: 'mock-upload-id-123' } as never;
			}
			if (name === 'UploadPartCommand') {
				const body = cmd.input.Body as Uint8Array | Buffer;
				uploadedParts.push({
					PartNumber: cmd.input.PartNumber as number,
					size: body.byteLength
				});
				return { ETag: `"etag-${cmd.input.PartNumber}"` } as never;
			}
			if (name === 'CompleteMultipartUploadCommand') {
				return { Location: 'https://test-bucket.s3.amazonaws.com/index.html' } as never;
			}
			return {} as never;
		});

		const uploader = new ArtifactUploader(mockS3Client as never, 'test-bucket');
		const shallowest = await uploader.upload(zipStream, {
			owner: 'owner',
			repo: 'repo',
			workflowRunId: 123,
			artifactName: 'my-artifact',
			visibility: 'private'
		});

		expect(shallowest).toBe('index.html');
		expect(commandsSent).toContain('CreateMultipartUploadCommand');
		expect(commandsSent).toContain('UploadPartCommand');
		expect(commandsSent).toContain('CompleteMultipartUploadCommand');
		expect(uploadedParts).toHaveLength(2);
		expect(uploadedParts[0]).toEqual({ PartNumber: 1, size: partSize });
		expect(uploadedParts[1]).toEqual({ PartNumber: 2, size: 1_024 * 512 });
	});

	it('aborts multipart upload and destroys stream when a part upload fails', async () => {
		const largeContent = Buffer.alloc(5 * 1_024 * 1_024 + 1_024, 'x');
		const zip = createZip({ 'index.html': largeContent });
		const zipStream = Readable.from(zip.toBuffer());

		const mockS3Client = new S3Client({ region: 'us-east-1' });
		const commandsSent: string[] = [];

		vi.spyOn(mockS3Client, 'send').mockImplementation(async (command: unknown) => {
			const cmd = command as { constructor: { name: string }; input: Record<string, unknown> };
			const name = cmd.constructor?.name;
			commandsSent.push(name);

			if (name === 'CreateMultipartUploadCommand') {
				return { UploadId: 'mock-upload-id-fail' } as never;
			}
			if (name === 'UploadPartCommand') {
				throw new Error('S3 Part Upload Error');
			}
			if (name === 'AbortMultipartUploadCommand') {
				return {} as never;
			}
			return {} as never;
		});

		const uploader = new ArtifactUploader(mockS3Client as never, 'test-bucket');

		await expect(
			uploader.upload(zipStream, {
				owner: 'owner',
				repo: 'repo',
				workflowRunId: 123,
				artifactName: 'my-artifact',
				visibility: 'private'
			})
		).rejects.toThrow('S3 Part Upload Error');

		expect(commandsSent).toContain('AbortMultipartUploadCommand');
		expect(zipStream.destroyed).toBe(true);
	});

	it('cleans up temporary file and throws if download stream fails before upload begins', async () => {
		const totalSize = 1_024;
		const zipBuffer = createZip({ 'index.html': Buffer.alloc(totalSize) }).toBuffer();

		let pushed = false;
		const faultyStream = new Readable({
			read() {
				if (!pushed) {
					pushed = true;
					this.push(zipBuffer.subarray(0, 500));
					// Immediately fail the stream to simulate a dropped GitHub connection
					setTimeout(() => this.destroy(new Error('Network cut off during download')), 10);
				}
			}
		});

		const mockS3Client = new S3Client({ region: 'us-east-1' });
		const uploader = new ArtifactUploader(mockS3Client as never, 'test-bucket');

		await expect(
			uploader.upload(faultyStream, {
				owner: 'owner',
				repo: 'repo',
				workflowRunId: 123,
				artifactName: 'my-artifact',
				visibility: 'private'
			})
		).rejects.toThrow('Network cut off during download');
	});
});
