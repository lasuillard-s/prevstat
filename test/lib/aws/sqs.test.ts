import { describe, expect, vi } from 'vitest';
import type { AppConfig } from '../../../src/config.js';
import { ArtifactProcessor, submitArtifactProcessingTasks } from '../../../src/lib/aws/sqs.js';
import { test as it } from '../../helpers.js';

describe('submitArtifactProcessingTasks', () => {
	it('submits artifact messages in chunks of 10 to SQS queue', async () => {
		const mockSend = vi.fn().mockResolvedValue({ Successful: [{}, {}], Failed: [] });
		const mockSqsClient = { send: mockSend } as never;

		const target = {
			installationId: 1234,
			owner: 'my-org',
			repo: 'my-repo',
			runId: 5678
		};

		const artifactIds = [1, 2];

		await submitArtifactProcessingTasks(
			mockSqsClient,
			'https://sqs.us-east-1.amazonaws.com/123/queue',
			target,
			artifactIds
		);

		expect(mockSend).toHaveBeenCalledTimes(1);
	});

	it('throws error when SQS batch returns failed items', async () => {
		const mockSend = vi.fn().mockResolvedValue({
			Successful: [],
			Failed: [{ Id: '1', Message: 'Queue error', Code: '500' }]
		});
		const mockSqsClient = { send: mockSend } as never;

		const target = {
			owner: 'my-org',
			repo: 'my-repo',
			runId: 5678
		};

		await expect(
			submitArtifactProcessingTasks(
				mockSqsClient,
				'https://sqs.us-east-1.amazonaws.com/123/queue',
				target,
				[1]
			)
		).rejects.toThrow('Failed to enqueue artifacts to SQS');
	});

	it('handles empty artifact list gracefully without sending SQS batch', async () => {
		const mockSend = vi.fn();
		const mockSqsClient = { send: mockSend } as never;

		await submitArtifactProcessingTasks(
			mockSqsClient,
			'https://sqs.us-east-1.amazonaws.com/123/queue',
			{ owner: 'my-org', repo: 'my-repo', runId: 1 },
			[]
		);

		expect(mockSend).not.toHaveBeenCalled();
	});

	it('splits 25 items into chunks of 10, 10, 5', async () => {
		const mockSend = vi.fn().mockResolvedValue({ Successful: [], Failed: [] });
		const mockSqsClient = { send: mockSend } as never;

		const artifactIds = Array.from({ length: 25 }, (_, i) => i + 1);

		await submitArtifactProcessingTasks(
			mockSqsClient,
			'https://sqs.us-east-1.amazonaws.com/123/queue',
			{ owner: 'my-org', repo: 'my-repo', runId: 1 },
			artifactIds
		);

		expect(mockSend).toHaveBeenCalledTimes(3);
	});
});

describe('ArtifactProcessor', () => {
	const mockConfig: AppConfig = {
		CLOUDFRONT_DOMAIN: 'assets.example.com',
		S3_BUCKET_NAME: 'test-bucket'
	} as AppConfig;

	it('processBatch processes all records and accumulates failures', async ({ probot }) => {
		const mockS3Client = { send: vi.fn() };

		const processor = new ArtifactProcessor(probot, mockConfig, mockS3Client as never);

		const processRecordSpy = vi
			.spyOn(processor, 'processRecord')
			.mockImplementation(async (record) => {
				if (record.messageId === 'msg-fail') {
					throw new Error('Processing failed');
				}
			});

		const records = [
			{ messageId: 'msg-1', body: '{}' },
			{ messageId: 'msg-fail', body: '{}' },
			{ messageId: 'msg-2', body: '{}' }
		];

		const failures = await processor.processBatch(records);

		expect(processRecordSpy).toHaveBeenCalledTimes(3);
		expect(failures).toEqual([{ itemIdentifier: 'msg-fail' }]);
	});
});
