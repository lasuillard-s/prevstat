import { CreateBucketCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import AdmZip from 'adm-zip';
import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import nock from 'nock';
import { afterEach, describe, expect } from 'vitest';
import { AppConfig } from '../../../src/config.js';
import { ProcessArtifactMessage } from '../../../src/lib/aws/sqs.js';
import { router as awsRouter } from '../../../src/routes/aws/index.js';
import { test as it } from '../../helpers.js';

describe('POST /aws/sqs router', () => {
	const region = 'us-east-1';
	const bucketName = 'router-test-bucket';

	let s3: S3Client;
	let app: express.Express;
	let server: http.Server;
	let serverUrl: string;
	let appConfig: AppConfig;

	const createZipBuffer = (files: Record<string, string>): Buffer => {
		const zip = new AdmZip();
		for (const [filename, content] of Object.entries(files)) {
			zip.addFile(filename, Buffer.from(content));
		}
		return zip.toBuffer();
	};

	it.beforeAll(async ({ localstack }) => {
		const clientConfig = {
			endpoint: localstack.href,
			region,
			credentials: {
				accessKeyId: 'test',
				secretAccessKey: 'test'
			}
		};
		s3 = new S3Client({ ...clientConfig, forcePathStyle: true });
		await s3.send(new CreateBucketCommand({ Bucket: bucketName }));
	});

	it.beforeEach(async ({ probot, localstack }) => {
		nock.cleanAll();
		nock.enableNetConnect(
			(host) =>
				host.includes(localstack.host) ||
				host.includes(localstack.hostname) ||
				host.includes('127.0.0.1') ||
				host.includes('localhost')
		);

		appConfig = {
			GITHUB_CLIENT_ID: 'client-id',
			GITHUB_CLIENT_SECRET: 'client-secret',
			ALLOWED_PRINCIPALS: ['*'],
			CLOUDFRONT_DOMAIN: 'assets.example.com',
			CLOUDFRONT_PRIVATE_KEY: 'key',
			CLOUDFRONT_KEY_PAIR_ID: 'key-pair-id',
			CLOUDFRONT_SIGNED_COOKIE_EXPIRATION_SECONDS: 900,
			JWT_SECRET: 'jwt-secret',
			JWT_EXPIRATION_SECONDS: 300,
			S3_BUCKET_NAME: bucketName,
			SQS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue',
			ARTIFACT_PATTERNS: ['my-org/my-repo:.github/workflows/ci.yaml:build*']
		};

		app = express();
		app.use(express.json());
		app.locals.probot = probot;
		app.locals.config = appConfig;
		app.locals.s3Client = s3;
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
		if (server) {
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
		}
	});

	const createMessage = (
		overrides: Partial<ProcessArtifactMessage> = {}
	): ProcessArtifactMessage => ({
		installationId: 1234,
		owner: 'my-org',
		repo: 'my-repo',
		runId: 12345,
		artifactId: 101,
		...overrides
	});

	it('downloads, unzips, uploads artifact to S3, and creates success commit status', async () => {
		const zipBuffer = createZipBuffer({
			'index.html': '<html>Hello World from Route Integration</html>',
			'styles/main.css': 'body { color: blue; }'
		});

		const mock = nock('https://api.github.com')
			.post('/app/installations/1234/access_tokens')
			.reply(201, { token: 'ghs_mocktoken', permissions: {} })
			.get('/repos/my-org/my-repo')
			.reply(200, { private: true })
			.get('/repos/my-org/my-repo/actions/artifacts/101')
			.reply(200, {
				id: 101,
				name: 'build-output-web',
				workflow_run: {
					id: 12345,
					head_sha: 'abcdef123456'
				}
			})
			.get('/repos/my-org/my-repo/actions/artifacts/101/zip')
			.reply(200, zipBuffer, { 'content-type': 'application/zip' })
			.post('/repos/my-org/my-repo/statuses/abcdef123456', {
				state: 'success',
				target_url:
					'https://assets.example.com/private/my-org/my-repo/12345/build-output-web/index.html',
				description: 'Successfully uploaded artifact build-output-web to S3.',
				context: 'Prevstat / build-output-web'
			})
			.reply(201, { state: 'success' });

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

		expect(mock.isDone()).toBe(true);
		expect(mock.pendingMocks()).toStrictEqual([]);

		// Verify files exist in LocalStack S3
		const htmlObj = await s3.send(
			new GetObjectCommand({
				Bucket: bucketName,
				Key: 'private/my-org/my-repo/12345/build-output-web/index.html'
			})
		);
		expect(await htmlObj.Body?.transformToString()).toBe(
			'<html>Hello World from Route Integration</html>'
		);
		expect(htmlObj.ContentType).toBe('text/html');

		const cssObj = await s3.send(
			new GetObjectCommand({
				Bucket: bucketName,
				Key: 'private/my-org/my-repo/12345/build-output-web/styles/main.css'
			})
		);
		expect(await cssObj.Body?.transformToString()).toBe('body { color: blue; }');
		expect(cssObj.ContentType).toBe('text/css');
	});

	it('handles failure when installationId is not provided', async () => {
		const message = createMessage();
		delete message.installationId; // remove installationId
		const response = await fetch(`${serverUrl}/aws/sqs`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				Records: [
					{
						messageId: 'msg-2',
						body: JSON.stringify(message)
					}
				]
			})
		});

		const json = await response.json();
		expect(response.status).toBe(200);
		expect(json).toEqual({ batchItemFailures: [{ itemIdentifier: 'msg-2' }] });
	});

	it('creates check run with failure conclusion when artifact download fails', async () => {
		const mock = nock('https://api.github.com')
			.post('/app/installations/1234/access_tokens')
			.reply(201, { token: 'ghs_mocktoken', permissions: {} })
			.get('/repos/my-org/my-repo')
			.reply(200, { private: true })
			.get('/repos/my-org/my-repo/actions/artifacts/101')
			.reply(200, {
				id: 101,
				name: 'build-output-web',
				workflow_run: {
					id: 12345,
					head_sha: 'abcdef123456'
				}
			})
			.get('/repos/my-org/my-repo/actions/artifacts/101/zip')
			.reply(500, 'Download failed')
			.post('/repos/my-org/my-repo/check-runs', (body) => {
				expect(body.conclusion).toBe('failure');
				expect(body.output?.summary).toBe('Failed to upload artifact build-output-web to S3.');
				return true;
			})
			.reply(201, { status: 'completed' });

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
		expect(json).toEqual({ batchItemFailures: [{ itemIdentifier: 'msg-1' }] });
		expect(mock.isDone()).toBe(true);
		expect(mock.pendingMocks()).toStrictEqual([]);
	});

	it('creates check run with failure conclusion when zip is corrupt', async () => {
		const mock = nock('https://api.github.com')
			.post('/app/installations/1234/access_tokens')
			.reply(201, { token: 'ghs_mocktoken', permissions: {} })
			.get('/repos/my-org/my-repo')
			.reply(200, { private: true })
			.get('/repos/my-org/my-repo/actions/artifacts/101')
			.reply(200, {
				id: 101,
				name: 'build-output-web',
				workflow_run: {
					id: 12345,
					head_sha: 'abcdef123456'
				}
			})
			.get('/repos/my-org/my-repo/actions/artifacts/101/zip')
			.reply(200, Buffer.from('invalid-zip-bytes'))
			.post('/repos/my-org/my-repo/check-runs', (body) => {
				expect(body.conclusion).toBe('failure');
				return true;
			})
			.reply(201, { status: 'completed' });

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
		expect(json).toEqual({ batchItemFailures: [{ itemIdentifier: 'msg-1' }] });
		expect(mock.isDone()).toBe(true);
		expect(mock.pendingMocks()).toStrictEqual([]);
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
