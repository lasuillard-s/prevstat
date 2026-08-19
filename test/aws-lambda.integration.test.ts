import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { PutParameterCommand } from '@aws-sdk/client-ssm';
import AdmZip from 'adm-zip';
import nock from 'nock';
import { describe, expect, vi } from 'vitest';
import { test as it } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const privateKey = fs.readFileSync(path.join(__dirname, 'fixtures/mock-cert.pem'), 'utf-8');

describe('aws-lambda.ts integration with LocalStack', () => {
	it('loads config from SSM, initializes Lambda handler, and processes SQS record uploading to S3', async ({
		localstack: fixture
	}) => {
		const localstackHost = new URL(fixture.endpoint).host;
		nock.enableNetConnect(
			(host) =>
				host.includes(localstackHost) || host.includes('127.0.0.1') || host.includes('localhost')
		);

		const configPayload = {
			APP_ID: '123',
			PRIVATE_KEY: privateKey,
			WEBHOOK_SECRET: 'development',
			GITHUB_CLIENT_ID: 'client-id',
			GITHUB_CLIENT_SECRET: 'client-secret',
			CLOUDFRONT_DOMAIN: 'assets.example.com',
			CLOUDFRONT_PRIVATE_KEY: 'key',
			CLOUDFRONT_KEY_PAIR_ID: 'key-pair-id',
			S3_BUCKET_NAME: fixture.s3BucketName,
			SQS_QUEUE_URL: fixture.sqsQueueUrl,
			ARTIFACT_PATTERNS: 'my-org/my-repo:.github/workflows/ci.yaml:build*',
			JWT_SECRET: 'jwt-secret'
		};

		await fixture.ssmClient.send(
			new PutParameterCommand({
				Name: '/presta/config',
				Value: JSON.stringify(configPayload),
				Type: 'String',
				Overwrite: true
			})
		);

		vi.stubEnv('LAMBDA_SSM_PARAMETER_NAME', '/presta/config');
		vi.stubEnv('AWS_ENDPOINT_URL', fixture.endpoint);
		vi.stubEnv('AWS_REGION', fixture.region);
		vi.stubEnv('AWS_ACCESS_KEY_ID', 'test');
		vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test');
		vi.stubEnv('AWS_S3_USE_PATH_STYLE_ENDPOINT', 'true');

		const zip = new AdmZip();
		zip.addFile('index.html', Buffer.from('<html>Integration Test</html>'));
		const zipBuffer = zip.toBuffer();

		nock('https://api.github.com')
			.post('/app/installations/1234/access_tokens')
			.reply(201, { token: 'ghs_mocktoken', permissions: {} });

		nock('https://api.github.com').get('/repos/my-org/my-repo').reply(200, { private: true });

		nock('https://api.github.com')
			.get('/repos/my-org/my-repo/actions/artifacts/101')
			.reply(200, {
				id: 101,
				name: 'build-output-web',
				workflow_run: {
					id: 12345,
					head_sha: 'abcdef123456'
				}
			});

		nock('https://api.github.com')
			.get('/repos/my-org/my-repo/actions/artifacts/101/zip')
			.reply(200, zipBuffer, { 'content-type': 'application/zip' });

		let commitStatusCreated = false;
		nock('https://api.github.com')
			.post('/repos/my-org/my-repo/statuses/abcdef123456', (body) => {
				expect(body.state).toBe('success');
				expect(body.target_url).toBe(
					`https://assets.example.com/private/my-org/my-repo/12345/build-output-web/index.html`
				);
				commitStatusCreated = true;
				return true;
			})
			.reply(201, { state: 'success' });

		const { handler } = await import('../src/aws-lambda.js');

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
					awsRegion: 'us-east-1'
				}
			]
		};

		const response = await handler(sqsEvent, {} as never);
		expect(response).toEqual({ batchItemFailures: [] });
		expect(commitStatusCreated).toBe(true);

		const s3Object = await fixture.s3Client.send(
			new GetObjectCommand({
				Bucket: fixture.s3BucketName,
				Key: 'private/my-org/my-repo/12345/build-output-web/index.html'
			})
		);
		const s3Content = await s3Object.Body?.transformToString();
		expect(s3Content).toBe('<html>Integration Test</html>');
	}, 60000);
});
