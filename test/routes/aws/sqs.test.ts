import { S3Client } from '@aws-sdk/client-s3';
import AdmZip from 'adm-zip';
import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import nock from 'nock';
import { Probot } from 'probot';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import { AppConfig } from '../../../src/config.js';
import { router as awsRouter } from '../../../src/routes/aws/index.js';
import { ProcessArtifactMessage } from '../../../src/sqs.js';
import { test as it } from '../../helpers.js';

describe('POST /aws/sqs router', () => {
	let app: express.Express;
	let server: http.Server;
	let serverUrl: string;
	let appConfig: AppConfig;
	let mockS3Client: S3Client;
	let mockS3Send: ReturnType<typeof vi.fn>;
	let mockOctokit: {
		rest: {
			actions: {
				downloadArtifact: ReturnType<typeof vi.fn>;
			};
			checks: {
				create: ReturnType<typeof vi.fn>;
			};
			repos: {
				createCommitStatus: ReturnType<typeof vi.fn>;
			};
		};
	};
	let mockProbot: Probot;

	const createZipBuffer = (files: Record<string, string>): Buffer => {
		const zip = new AdmZip();
		for (const [filename, content] of Object.entries(files)) {
			zip.addFile(filename, Buffer.from(content));
		}
		return zip.toBuffer();
	};

	beforeEach(async () => {
		nock.enableNetConnect(/(127\.0\.0\.1|localhost)/);

		appConfig = {
			GITHUB_CLIENT_ID: 'client-id',
			GITHUB_CLIENT_SECRET: 'client-secret',
			CLOUDFRONT_DOMAIN: 'assets.example.com',
			CLOUDFRONT_PRIVATE_KEY: 'key',
			CLOUDFRONT_KEY_PAIR_ID: 'key-pair-id',
			CLOUDFRONT_SIGNED_COOKIE_EXPIRATION_SECONDS: 900,
			JWT_SECRET: 'jwt-secret',
			JWT_EXPIRATION_SECONDS: 300,
			S3_BUCKET_NAME: 'test-bucket',
			SQS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue',
			ARTIFACT_PATTERNS: ['my-org/my-repo:.github/workflows/ci.yaml:build-output*']
		};

		mockS3Send = vi.fn().mockResolvedValue({});
		mockS3Client = {
			send: mockS3Send
		} as unknown as S3Client;

		mockOctokit = {
			rest: {
				actions: {
					downloadArtifact: vi.fn()
				},
				checks: {
					create: vi.fn().mockResolvedValue({})
				},
				repos: {
					createCommitStatus: vi.fn().mockResolvedValue({})
				}
			}
		};

		mockProbot = {
			log: {
				debug: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn()
			},
			auth: vi.fn().mockResolvedValue(mockOctokit)
		} as unknown as Probot;

		app = express();
		app.use(express.json());
		app.locals.probot = mockProbot;
		app.locals.config = appConfig;
		app.locals.s3Client = mockS3Client;
		app.use('/aws', awsRouter);

		server = http.createServer(app);
		await new Promise<void>((resolve) => {
			server.listen(0, () => {
				const port = (server.address() as AddressInfo).port;
				serverUrl = `http://127.0.0.1:${port}`;
				resolve();
			});
		});
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
	});

	const createMessage = (
		overrides: Partial<ProcessArtifactMessage> = {}
	): ProcessArtifactMessage => ({
		installationId: 1234,
		repository: {
			name: 'my-repo',
			full_name: 'my-org/my-repo',
			private: true,
			owner: {
				login: 'my-org'
			}
		},
		workflowRun: {
			id: 12345,
			name: 'CI',
			path: '.github/workflows/ci.yaml',
			head_sha: 'abcdef123456'
		},
		artifact: {
			id: 101,
			name: 'build-output-web'
		},
		...overrides
	});

	it('downloads, unzips, uploads artifact to S3, and creates success commit status', async () => {
		const zipBuffer = createZipBuffer({
			'index.html': '<html>Hello World</html>',
			'styles/main.css': 'body { color: blue; }'
		});

		mockOctokit.rest.actions.downloadArtifact.mockResolvedValue({
			data: zipBuffer.buffer.slice(
				zipBuffer.byteOffset,
				zipBuffer.byteOffset + zipBuffer.byteLength
			)
		});

		const message = createMessage();
		const response = await fetch(`${serverUrl}/aws/sqs`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				Records: [
					{
						messageId: 'msg-1',
						body: JSON.stringify(message)
					}
				]
			})
		});

		const json = await response.json();
		expect(response.status).toBe(200);
		expect(json).toEqual({ batchItemFailures: [] });

		expect(mockProbot.auth).toHaveBeenCalledWith(1234);
		expect(mockOctokit.rest.actions.downloadArtifact).toHaveBeenCalledWith({
			owner: 'my-org',
			repo: 'my-repo',
			artifact_id: 101,
			archive_format: 'zip'
		});

		expect(mockS3Send).toHaveBeenCalledTimes(2);
		expect(mockS3Send).toHaveBeenCalledWith(
			expect.objectContaining({
				input: expect.objectContaining({
					Bucket: 'test-bucket',
					Key: 'private/my-org/my-repo/12345/build-output-web/index.html',
					ContentType: 'text/html'
				})
			})
		);
		expect(mockS3Send).toHaveBeenCalledWith(
			expect.objectContaining({
				input: expect.objectContaining({
					Bucket: 'test-bucket',
					Key: 'private/my-org/my-repo/12345/build-output-web/styles/main.css',
					ContentType: 'text/css'
				})
			})
		);

		expect(mockOctokit.rest.repos.createCommitStatus).toHaveBeenCalledWith({
			owner: 'my-org',
			repo: 'my-repo',
			sha: 'abcdef123456',
			state: 'success',
			target_url:
				'https://assets.example.com/private/my-org/my-repo/12345/build-output-web/index.html',
			description: 'Successfully uploaded artifact build-output-web to S3.',
			context: 'Presta / build-output-web'
		});
		expect(mockOctokit.rest.checks.create).not.toHaveBeenCalled();
	});

	it('creates check run with failure conclusion when artifact download fails', async () => {
		mockOctokit.rest.actions.downloadArtifact.mockRejectedValue(new Error('Download failed'));

		const message = createMessage();
		const response = await fetch(`${serverUrl}/aws/sqs`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				Records: [
					{
						messageId: 'msg-1',
						body: JSON.stringify(message)
					}
				]
			})
		});

		const json = await response.json();
		expect(response.status).toBe(200);
		expect(json).toEqual({ batchItemFailures: [] });

		expect(mockOctokit.rest.checks.create).toHaveBeenCalledWith(
			expect.objectContaining({
				conclusion: 'failure',
				output: expect.objectContaining({
					summary: 'Failed to upload artifact build-output-web to S3.'
				})
			})
		);
	});

	it('creates check run with failure conclusion when S3 upload fails', async () => {
		const zipBuffer = createZipBuffer({
			'index.html': '<html>Hello World</html>'
		});

		mockOctokit.rest.actions.downloadArtifact.mockResolvedValue({
			data: zipBuffer.buffer.slice(
				zipBuffer.byteOffset,
				zipBuffer.byteOffset + zipBuffer.byteLength
			)
		});
		mockS3Send.mockRejectedValue(new Error('S3 Access Denied'));

		const message = createMessage();
		const response = await fetch(`${serverUrl}/aws/sqs`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				Records: [
					{
						messageId: 'msg-1',
						body: JSON.stringify(message)
					}
				]
			})
		});

		const json = await response.json();
		expect(response.status).toBe(200);
		expect(json).toEqual({ batchItemFailures: [] });

		expect(mockOctokit.rest.checks.create).toHaveBeenCalledWith(
			expect.objectContaining({
				conclusion: 'failure'
			})
		);
	});

	it('creates check run with failure conclusion when zip is corrupt', async () => {
		mockOctokit.rest.actions.downloadArtifact.mockResolvedValue({
			data: Buffer.from('invalid-zip-bytes')
		});

		const message = createMessage();
		const response = await fetch(`${serverUrl}/aws/sqs`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				Records: [
					{
						messageId: 'msg-1',
						body: JSON.stringify(message)
					}
				]
			})
		});

		const json = await response.json();
		expect(response.status).toBe(200);
		expect(json).toEqual({ batchItemFailures: [] });

		expect(mockOctokit.rest.checks.create).toHaveBeenCalledWith(
			expect.objectContaining({
				conclusion: 'failure'
			})
		);
	});

	it('reports batchItemFailures for malformed or unhandled records', async () => {
		const response = await fetch(`${serverUrl}/aws/sqs`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				Records: [
					{
						messageId: 'msg-bad',
						body: 'not-valid-json'
					}
				]
			})
		});

		const json = await response.json();
		expect(response.status).toBe(200);
		expect(json).toEqual({
			batchItemFailures: [{ itemIdentifier: 'msg-bad' }]
		});
	});

	it('handles empty records array', async () => {
		const response = await fetch(`${serverUrl}/aws/sqs`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({})
		});

		const json = await response.json();
		expect(response.status).toBe(200);
		expect(json).toEqual({ batchItemFailures: [] });
	});
});
