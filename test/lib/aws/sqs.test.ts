import { describe, expect, it, vi } from 'vitest';
import { submitArtifactProcessingTasks } from '../../../src/lib/aws/sqs.js';

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
		).rejects.toThrow('Failed to enqueue artifacts to SQS: entry 1: Queue error (500)');
	});

	it('throws error when SQS client send rejects', async () => {
		const mockSend = vi.fn().mockRejectedValue(new Error('Network failure'));
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
		).rejects.toThrow('Network failure');
	});
});
