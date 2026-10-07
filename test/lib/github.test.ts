import { S3Client } from '@aws-sdk/client-s3';
import AdmZip from 'adm-zip';
import nock from 'nock';
import crypto from 'node:crypto';
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

	it('uploads descriptor-based ZIP entries correctly without relying on ContentLength', async () => {
		// In the PKZip format specification (APPNOTE.TXT), when general purpose flag bit 3 (0x08) is set,
		// the local file header (signature 0x04034b50) records CRC-32 (offset 14), compressed size (offset 18),
		// and uncompressed size (offset 22) as 0. The actual values are placed in a 16-byte Data Descriptor
		// record (signature 0x08074b50) placed immediately after the file payload.
		// Standard in-memory libraries (like AdmZip) populate sizes in the local header directly, so we manually
		// set bit 3, zero out the header size fields, and append the descriptor to reproduce descriptor-based archives.
		const zip = new AdmZip();
		zip.addFile('index.html', Buffer.from('hello descriptor'));
		const buf = zip.toBuffer();

		const chunks: Buffer[] = [];
		let offset = 0;
		while (offset < buf.length) {
			const sig = buf.readUInt32LE(offset);
			if (sig === 0x04034b50) {
				const crc = buf.readUInt32LE(offset + 14);
				const comp = buf.readUInt32LE(offset + 18);
				const uncomp = buf.readUInt32LE(offset + 22);
				const nameLen = buf.readUInt16LE(offset + 26);
				const extLen = buf.readUInt16LE(offset + 28);
				const headerEnd = offset + 30 + nameLen + extLen;
				const dataEnd = headerEnd + comp;

				const header = Buffer.from(buf.subarray(offset, headerEnd));
				header[6] |= 0x08; // Flag bit 3: indicate presence of data descriptor
				header.writeUInt32LE(0, 14); // Zero CRC-32
				header.writeUInt32LE(0, 18); // Zero compressed size
				header.writeUInt32LE(0, 22); // Zero uncompressed size

				const data = buf.subarray(headerEnd, dataEnd);

				// 16-byte Data Descriptor: [signature 4B][CRC-32 4B][compressed size 4B][uncompressed size 4B]
				const desc = Buffer.alloc(16);
				desc.writeUInt32LE(0x08074b50, 0);
				desc.writeUInt32LE(crc, 4);
				desc.writeUInt32LE(comp, 8);
				desc.writeUInt32LE(uncomp, 12);

				chunks.push(header, data, desc);
				offset = dataEnd;
			} else {
				break;
			}
		}

		const descriptorZip = Buffer.concat(chunks);
		const zipStream = Readable.from(descriptorZip);

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

	it('aborts multipart upload and cleans up when download fails during multipart content', async () => {
		const totalSize = 6 * 1_024 * 1_024; // 6 MiB total
		const largeContent = crypto.randomBytes(totalSize);
		const zip = createZip({ 'index.html': largeContent });
		const zipBuffer = zip.toBuffer();

		// S3 multipart uploads require a minimum part size of 5 MiB (5 * 1_024 * 1_024 = 5_242_880 bytes).
		// Upload will only trigger UploadPartCommand for Part 1 once it has received at least 5 MiB.
		// We push 5_800_000 bytes (approx 5.53 MiB) of random, incompressible data: this is enough to trigger Part 1
		// upload, but leaves Part 2 incomplete (total 6 MiB), enabling us to simulate a download failure while
		// a multipart upload is actively in progress.
		const partialSize = 5_800_000;
		let pushed = false;
		const faultyStream = new Readable({
			read() {
				if (!pushed) {
					pushed = true;
					this.push(zipBuffer.subarray(0, partialSize));
				}
			}
		});

		const mockS3Client = new S3Client({ region: 'us-east-1' });
		const commandsSent: string[] = [];

		vi.spyOn(mockS3Client, 'send').mockImplementation(async (command: unknown) => {
			const cmd = command as { constructor: { name: string }; input: Record<string, unknown> };
			const name = cmd.constructor?.name;
			commandsSent.push(name);

			if (name === 'CreateMultipartUploadCommand') {
				return { UploadId: 'mock-upload-id-abort' } as never;
			}
			if (name === 'UploadPartCommand') {
				faultyStream.destroy(new Error('Network cut off during large download'));
				return { ETag: `"etag-${cmd.input.PartNumber}"` } as never;
			}
			if (name === 'AbortMultipartUploadCommand') {
				return {} as never;
			}
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
		).rejects.toThrow('Network cut off during large download');

		expect(commandsSent).toContain('AbortMultipartUploadCommand');
		expect(faultyStream.destroyed).toBe(true);
	});
});
