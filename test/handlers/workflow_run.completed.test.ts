import { SQSClient } from '@aws-sdk/client-sqs';
import { Context } from 'probot';
import { beforeEach, describe, expect, vi } from 'vitest';
import { AppConfig } from '../../src/config.js';
import WorkflowRunCompletedHandler from '../../src/handlers/workflow_run.completed.js';
import { test as it } from '../helpers.js';

describe('WorkflowRunCompletedHandler', () => {
	let appConfig: AppConfig;
	let mockSqsClient: SQSClient;
	let mockSend: ReturnType<typeof vi.fn>;
	let mockOctokit: {
		rest: {
			actions: {
				listWorkflowRunArtifacts: ReturnType<typeof vi.fn>;
			};
		};
	};
	let mockLog: {
		debug: ReturnType<typeof vi.fn>;
		info: ReturnType<typeof vi.fn>;
		warn: ReturnType<typeof vi.fn>;
		error: ReturnType<typeof vi.fn>;
	};

	beforeEach(() => {
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

		mockSend = vi.fn().mockResolvedValue({});
		mockSqsClient = {
			send: mockSend
		} as unknown as SQSClient;

		mockOctokit = {
			rest: {
				actions: {
					listWorkflowRunArtifacts: vi.fn()
				}
			}
		};

		mockLog = {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn()
		};
	});

	const createHandler = (
		payloadOverrides: Record<string, unknown> = {},
		sqsClient: SQSClient = mockSqsClient
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

		const context = {
			payload,
			octokit: mockOctokit,
			log: mockLog,
			repo: () => ({ owner: 'my-org', repo: 'my-repo' })
		} as unknown as Context<'workflow_run.completed'>;

		return new WorkflowRunCompletedHandler(context, appConfig, sqsClient);
	};

	it('skips artifacts that do not match ARTIFACT_PATTERNS', async () => {
		mockOctokit.rest.actions.listWorkflowRunArtifacts.mockResolvedValue({
			data: {
				artifacts: [{ id: 1, name: 'other-artifact' }]
			}
		});

		const handler = createHandler();
		await handler.handle();

		expect(mockSend).not.toHaveBeenCalled();
	});

	it('enqueues matched artifacts to SQS in a batch', async () => {
		mockOctokit.rest.actions.listWorkflowRunArtifacts.mockResolvedValue({
			data: {
				artifacts: [
					{ id: 101, name: 'build-output-web' },
					{ id: 102, name: 'other-artifact' },
					{ id: 103, name: 'build-output-docs' }
				]
			}
		});

		const handler = createHandler();
		await handler.handle();

		expect(mockSend).toHaveBeenCalledTimes(1);
		expect(mockSend).toHaveBeenCalledWith(
			expect.objectContaining({
				input: {
					QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue',
					Entries: [
						{
							Id: '101',
							MessageBody: JSON.stringify({
								installationId: 9999,
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
								}
							})
						},
						{
							Id: '103',
							MessageBody: JSON.stringify({
								installationId: 9999,
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
									id: 103,
									name: 'build-output-docs'
								}
							})
						}
					]
				}
			})
		);
	});

	it('chunks batches when more than 10 artifacts are matched', async () => {
		const artifacts = Array.from({ length: 15 }, (_, i) => ({
			id: 100 + i,
			name: `build-output-${i}`
		}));

		mockOctokit.rest.actions.listWorkflowRunArtifacts.mockResolvedValue({
			data: { artifacts }
		});

		const handler = createHandler();
		await handler.handle();

		expect(mockSend).toHaveBeenCalledTimes(2);
		expect(mockSend).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				input: expect.objectContaining({
					Entries: expect.arrayContaining([expect.objectContaining({ Id: '100' })])
				})
			})
		);
		expect(mockSend).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				input: expect.objectContaining({
					Entries: expect.arrayContaining([expect.objectContaining({ Id: '110' })])
				})
			})
		);
	});

	it('handles SQS batch with Failed entries gracefully', async () => {
		mockOctokit.rest.actions.listWorkflowRunArtifacts.mockResolvedValue({
			data: {
				artifacts: [{ id: 101, name: 'build-output-web' }]
			}
		});
		mockSend.mockResolvedValue({
			Successful: [],
			Failed: [
				{
					Id: '101',
					Code: 'InternalError',
					Message: 'Service unavailable',
					SenderFault: false
				}
			]
		});

		const handler = createHandler();
		await expect(handler.handle()).resolves.not.toThrow();
	});

	it('handles listWorkflowRunArtifacts errors gracefully', async () => {
		mockOctokit.rest.actions.listWorkflowRunArtifacts.mockRejectedValue(new Error('Network error'));

		const handler = createHandler();
		await expect(handler.handle()).resolves.not.toThrow();

		expect(mockSend).not.toHaveBeenCalled();
	});

	it('handles SQS send errors gracefully', async () => {
		mockOctokit.rest.actions.listWorkflowRunArtifacts.mockResolvedValue({
			data: {
				artifacts: [{ id: 101, name: 'build-output-web' }]
			}
		});
		mockSend.mockRejectedValue(new Error('SQS error'));

		const handler = createHandler();
		await expect(handler.handle()).resolves.not.toThrow();
	});
});
