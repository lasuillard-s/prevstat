import {
	CreateQueueCommand,
	PurgeQueueCommand,
	ReceiveMessageCommand,
	SQSClient
} from '@aws-sdk/client-sqs';
import nock from 'nock';
import type { Context, Probot } from 'probot';
import { describe, expect } from 'vitest';
import { AppConfig } from '../../src/config.js';
import WorkflowRunCompletedHandler from '../../src/event-handlers/workflow_run.completed.js';
import { test as it } from '../helpers.js';

describe('WorkflowRunCompletedHandler (Integration with LocalStack)', () => {
	const region = 'us-east-1';
	let sqs: SQSClient;
	let queueUrl: string;
	let appConfig: AppConfig;

	it.beforeAll(async ({ localstack }) => {
		const clientConfig = {
			endpoint: localstack.href,
			region,
			credentials: {
				accessKeyId: 'test',
				secretAccessKey: 'test'
			}
		};

		// Provision a dedicated SQS queue for this integration test
		sqs = new SQSClient(clientConfig);
		const createQueueResponse = await sqs.send(
			new CreateQueueCommand({ QueueName: 'workflow-run-completed-queue' })
		);
		queueUrl = createQueueResponse.QueueUrl!;

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
			SQS_QUEUE_URL: queueUrl,
			ARTIFACT_PATTERNS: ['my-org/my-repo:.github/workflows/ci.yaml:build-output*'],
			ALLOWED_PRINCIPALS: ['*']
		};
	});

	it.beforeEach(async ({ localstack }) => {
		nock.cleanAll();
		nock.enableNetConnect(
			(host) => host.includes(localstack.host) || host.includes(localstack.hostname)
		);

		// Purge any residual messages from previous tests
		try {
			await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
		} catch {
			// PurgeQueue has a 60s cooldown; ignore if called too frequently
		}
	});

	const createHandler = async (
		probot: Probot,
		payloadOverrides: Record<string, unknown> = {},
		sqsClient: SQSClient = sqs,
		configOverrides: Partial<AppConfig> = {}
	) => {
		const payload = {
			installation: {
				id: 9999
			},
			repository: {
				name: 'my-repo',
				full_name: 'my-org/my-repo',
				private: true,
				owner: {
					login: 'my-org'
				}
			},
			workflow_run: {
				id: 12345,
				name: 'CI',
				path: '.github/workflows/ci.yaml',
				head_sha: 'abcdef123456'
			},
			...payloadOverrides
		};
		const octokit = await probot.auth(9999);
		const context = {
			payload,
			octokit,
			log: probot.log,
			repo: () => ({ owner: 'my-org', repo: 'my-repo' })
		} as unknown as Context<'workflow_run.completed'>;

		return new WorkflowRunCompletedHandler(
			context,
			{ ...appConfig, ...configOverrides },
			sqsClient
		);
	};

	it('skips artifacts that do not match ARTIFACT_PATTERNS', async ({ probot }) => {
		const mock = nock('https://api.github.com')
			.post('/app/installations/9999/access_tokens')
			.reply(201, { token: 'ghs_mocktoken', permissions: {} })
			.get('/repos/my-org/my-repo/actions/runs/12345/artifacts')
			.reply(200, {
				artifacts: [{ id: 1, name: 'other-artifact' }]
			});

		const handler = await createHandler(probot);
		await handler.handle();

		expect(mock.isDone()).toBe(true);
		expect(mock.pendingMocks()).toStrictEqual([]);

		const receiveRes = await sqs.send(
			new ReceiveMessageCommand({
				QueueUrl: queueUrl,
				MaxNumberOfMessages: 10,
				WaitTimeSeconds: 1
			})
		);
		expect(receiveRes.Messages).toBeUndefined();
	});

	it('enqueues matched artifacts to real SQS in a batch', async ({ probot }) => {
		const mock = nock('https://api.github.com')
			.post('/app/installations/9999/access_tokens')
			.reply(201, { token: 'ghs_mocktoken', permissions: {} })
			.get('/repos/my-org/my-repo/actions/runs/12345/artifacts')
			.reply(200, {
				artifacts: [
					{ id: 101, name: 'build-output-web' },
					{ id: 102, name: 'other-artifact' },
					{ id: 103, name: 'build-output-docs' }
				]
			});

		const handler = await createHandler(probot);
		await handler.handle();

		expect(mock.isDone()).toBe(true);
		expect(mock.pendingMocks()).toStrictEqual([]);

		const receiveRes = await sqs.send(
			new ReceiveMessageCommand({
				QueueUrl: queueUrl,
				MaxNumberOfMessages: 10,
				WaitTimeSeconds: 1
			})
		);
		expect(receiveRes.Messages).toBeDefined();
		expect(receiveRes.Messages?.length).toBe(2);

		const bodies = receiveRes.Messages?.map((m) => JSON.parse(m.Body!));
		expect(bodies).toEqual(
			expect.arrayContaining([
				{
					installationId: 9999,
					owner: 'my-org',
					repo: 'my-repo',
					runId: 12345,
					artifactId: 101
				},
				{
					installationId: 9999,
					owner: 'my-org',
					repo: 'my-repo',
					runId: 12345,
					artifactId: 103
				}
			])
		);
	});

	it('chunks batches when more than 10 artifacts are matched', async ({ probot }) => {
		const artifacts = Array.from({ length: 15 }, (_, i) => ({
			id: 100 + i,
			name: `build-output-${i}`
		}));

		const mock = nock('https://api.github.com')
			.post('/app/installations/9999/access_tokens')
			.reply(201, { token: 'ghs_mocktoken', permissions: {} })
			.get('/repos/my-org/my-repo/actions/runs/12345/artifacts')
			.reply(200, { artifacts });

		const handler = await createHandler(probot);
		await handler.handle();

		expect(mock.isDone()).toBe(true);
		expect(mock.pendingMocks()).toStrictEqual([]);
	});

	it('handles listWorkflowRunArtifacts errors gracefully', async ({ probot }) => {
		const mock = nock('https://api.github.com')
			.post('/app/installations/9999/access_tokens')
			.reply(201, { token: 'ghs_mocktoken', permissions: {} })
			.get('/repos/my-org/my-repo/actions/runs/12345/artifacts')
			.reply(500, 'Network error');

		const handler = await createHandler(probot);
		await expect(handler.handle()).resolves.not.toThrow();

		expect(mock.isDone()).toBe(true);
		expect(mock.pendingMocks()).toStrictEqual([]);
	});

	it('handles SQS send errors gracefully', async ({ probot }) => {
		const mock = nock('https://api.github.com')
			.post('/app/installations/9999/access_tokens')
			.reply(201, { token: 'ghs_mocktoken', permissions: {} })
			.get('/repos/my-org/my-repo/actions/runs/12345/artifacts')
			.reply(200, {
				artifacts: [{ id: 101, name: 'build-output-web' }]
			});

		// Pass non-existent queue URL to trigger SQS error
		const handler = await createHandler(probot, {}, sqs, {
			SQS_QUEUE_URL: `${queueUrl}-non-existent`
		});
		await expect(handler.handle()).resolves.not.toThrow();

		expect(mock.isDone()).toBe(true);
		expect(mock.pendingMocks()).toStrictEqual([]);
	});
});
