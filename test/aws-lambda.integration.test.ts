import {
	CreateBucketCommand,
	GetObjectCommand,
	PutObjectCommand,
	S3Client
} from '@aws-sdk/client-s3';
import { CreateQueueCommand, SQSClient } from '@aws-sdk/client-sqs';
import AdmZip from 'adm-zip';
import fs from 'fs';
import nock from 'nock';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, vi } from 'vitest';
import { createLambdaHandler } from '../src/app.js';
import { test as it } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const privateKey = fs.readFileSync(path.join(__dirname, 'fixtures/mock-cert.pem'), 'utf-8');

describe('AWS integration with LocalStack', () => {
	const region = 'us-east-1';

	let s3: S3Client;
	let sqs: SQSClient;

	const bucketName = 'test-bucket';
	let queueUrl: string;

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
		sqs = new SQSClient(clientConfig);

		// Create resources in LocalStack for testing
		await s3.send(new CreateBucketCommand({ Bucket: bucketName }));

		const createQueueResponse = await sqs.send(new CreateQueueCommand({ QueueName: 'test-queue' }));
		queueUrl = createQueueResponse.QueueUrl!;
	});

	it.beforeEach(({ localstack }) => {
		nock.enableNetConnect(
			(host) => host.includes(localstack.host) || host.includes(localstack.hostname)
		);

		// Set environment variables for AWS SDK to use LocalStack
		vi.stubEnv('AWS_ENDPOINT_URL', localstack.href);
		vi.stubEnv('AWS_REGION', region);
		vi.stubEnv('AWS_ACCESS_KEY_ID', 'test');
		vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test');
		vi.stubEnv('AWS_S3_USE_PATH_STYLE_ENDPOINT', 'true');
	});

	it('loads config from S3, initializes Lambda handler, and processes SQS record uploading to S3', async () => {
		const configPayload = {
			APP_ID: '123',
			PRIVATE_KEY: privateKey,
			WEBHOOK_SECRET: 'development',
			GITHUB_CLIENT_ID: 'client-id',
			GITHUB_CLIENT_SECRET: 'client-secret',
			CLOUDFRONT_DOMAIN: 'assets.example.com',
			CLOUDFRONT_PRIVATE_KEY: 'key',
			CLOUDFRONT_KEY_PAIR_ID: 'key-pair-id',
			S3_BUCKET_NAME: bucketName,
			SQS_QUEUE_URL: queueUrl,
			ARTIFACT_PATTERNS: 'my-org/my-repo:.github/workflows/ci.yaml:build*',
			JWT_SECRET: 'jwt-secret'
		};

		const zip = new AdmZip();
		zip.addFile('index.html', Buffer.from('<html>Integration Test</html>'));
		const zipBuffer = zip.toBuffer();

		// Mock GitHub API responses
		let commitStatusCreated = false;
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
			.post('/repos/my-org/my-repo/statuses/abcdef123456', (body) => {
				expect(body.state).toBe('success');
				expect(body.target_url).toBe(
					`https://assets.example.com/private/my-org/my-repo/12345/build-output-web/index.html`
				);
				commitStatusCreated = true;
				return true;
			})
			.reply(201, { state: 'success' });

		await s3.send(
			new PutObjectCommand({
				Bucket: bucketName,
				Key: 'config.json',
				Body: JSON.stringify(configPayload)
			})
		);
		vi.stubEnv('LAMBDA_S3_CONFIG_BUCKET', bucketName);
		vi.stubEnv('LAMBDA_S3_CONFIG_KEY', 'config.json');
		const handler = await createLambdaHandler();

		const sqsEvent = {
			Records: [
				{
					messageId: 'msg-int-1',
					body: JSON.stringify({
						installationId: 1234,
						owner: 'my-org',
						repo: 'my-repo',
						runId: 12345,
						artifactId: 101
					}),
					eventSource: 'aws:sqs',
					awsRegion: region
				}
			]
		};

		const response = await handler(sqsEvent, {} as never);
		expect(response).toEqual({ batchItemFailures: [] });
		expect(commitStatusCreated).toBe(true);
		expect(mock.isDone()).toBe(true);
		expect(mock.pendingMocks()).toStrictEqual([]);

		const s3Object = await s3.send(
			new GetObjectCommand({
				Bucket: bucketName,
				Key: 'private/my-org/my-repo/12345/build-output-web/index.html'
			})
		);
		const s3Content = await s3Object.Body?.transformToString();
		expect(s3Content).toBe('<html>Integration Test</html>');
	}, 60000);
});
