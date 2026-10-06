import { S3Client } from '@aws-sdk/client-s3';
import { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { Probot, ProbotOctokit } from 'probot';
import type { AppConfig } from '../../config.js';
import { APP_NAME } from '../../constants.js';
import { errorToString } from '../../utils/string.js';
import { ArtifactDownloader, ArtifactUploader } from '../github.js';
import { buildArtifactPath } from '../url.js';

/**
 * Payload sent to SQS to process a matched GitHub Actions workflow artifact.
 */
export interface ProcessArtifactMessage {
	installationId?: number;
	owner: string;
	repo: string;
	runId: number;
	artifactId: number;
}

export interface SQSRecord {
	messageId: string;
	body: string;
	[key: string]: unknown;
}

export interface SQSEvent {
	Records?: SQSRecord[];
}

export interface BatchItemFailure {
	itemIdentifier: string;
}

/**
 * Target artifact to submit for asynchronous processing.
 */
export interface ArtifactProcessingTarget {
	id: number;
	name: string;
}

/**
 * Submits artifact processing tasks to the configured SQS queue in batches of 10.
 * Throws an error if enqueuing fails.
 * @param sqsClient SQS client instance
 * @param queueUrl Target SQS queue URL
 * @param target Repository and workflow run identifiers
 * @param target.installationId Optional GitHub App installation ID
 * @param target.owner Repository owner (organization or user)
 * @param target.repo Repository name
 * @param target.runId GitHub Actions workflow run ID
 * @param artifactIds Array of artifact IDs to process
 */
export async function submitArtifactProcessingTasks(
	sqsClient: SQSClient,
	queueUrl: string,
	target: {
		installationId?: number;
		owner: string;
		repo: string;
		runId: number;
	},
	artifactIds: number[]
): Promise<void> {
	const chunkSize = 10;
	for (let i = 0; i < artifactIds.length; i += chunkSize) {
		const chunk = artifactIds.slice(i, i + chunkSize);
		const entries = chunk.map((artifactId) => {
			const message: ProcessArtifactMessage = {
				installationId: target.installationId,
				owner: target.owner,
				repo: target.repo,
				runId: target.runId,
				artifactId
			};

			return {
				Id: artifactId.toString(),
				MessageBody: JSON.stringify(message)
			};
		});

		const result = await sqsClient.send(
			new SendMessageBatchCommand({
				QueueUrl: queueUrl,
				Entries: entries
			})
		);

		if (result.Failed && result.Failed.length > 0) {
			const failures = result.Failed.map(
				(f) => `entry ${f.Id}: ${f.Message ?? 'unknown error'} (${f.Code ?? 'unknown code'})`
			).join(', ');
			throw new Error(`Failed to enqueue artifacts to SQS: ${failures}`);
		}
	}
}

/**
 * Worker class that processes SQS records containing GitHub Actions artifact tasks.
 */
export class ArtifactProcessor {
	private readonly uploader: ArtifactUploader;

	constructor(
		private readonly probot: Probot,
		private readonly config: AppConfig,
		private readonly s3Client?: S3Client
	) {
		this.s3Client =
			s3Client ??
			new S3Client({
				// See https://github.com/aws/aws-sdk-js-v3/issues/7136
				forcePathStyle: process.env.AWS_S3_USE_PATH_STYLE_ENDPOINT === 'true'
			});
		this.uploader = new ArtifactUploader(this.s3Client, this.config.S3_BUCKET_NAME);
	}

	/**
	 * Processes an individual SQS record containing artifact processing information.
	 * Throws an error if any step in processing fails.
	 * @param record SQS record containing the message body
	 */
	async processRecord(record: SQSRecord): Promise<void> {
		const message: ProcessArtifactMessage = JSON.parse(record.body);
		const { installationId, owner, repo, runId, artifactId } = message;

		const octokit = (
			installationId ? await this.probot.auth(installationId) : await this.probot.auth()
		) as ProbotOctokit;

		// Fetch repository to determine visibility (private vs public)
		const { data: repository } = await octokit.rest.repos.get({
			owner,
			repo
		});
		const visibility = repository.private ? 'private' : 'public';

		// Fetch artifact details (name, workflow run sha, etc.)
		const { data: artifact } = await octokit.rest.actions.getArtifact({
			owner,
			repo,
			artifact_id: artifactId
		});

		const workflowRunId = artifact.workflow_run?.id ?? runId;
		const headSha = artifact.workflow_run?.head_sha;

		this.probot.log.info(
			`Processing artifact ${artifact.name} (id: ${artifact.id}) for ${owner}/${repo} workflow run ${workflowRunId}`
		);

		const path = buildArtifactPath(
			visibility,
			owner,
			repo,
			workflowRunId,
			artifact.name,
			'index.html'
		);
		const targetUrl = `https://${this.config.CLOUDFRONT_DOMAIN}${path}`;

		const downloader = new ArtifactDownloader(octokit);

		try {
			const zipBuffer = await downloader.download(owner, repo, artifact.id);
			await this.uploader.upload(zipBuffer, {
				artifactName: artifact.name,
				visibility,
				owner,
				repo,
				workflowRunId
			});
		} catch (error) {
			if (headSha) {
				await octokit.rest.checks.create({
					owner,
					repo,
					name: `${APP_NAME} / ${artifact.name}`,
					head_sha: headSha,
					status: 'completed',
					conclusion: 'failure',
					details_url: targetUrl,
					output: {
						title: `Artifact: ${artifact.name}`,
						summary: `Failed to upload artifact ${artifact.name} to S3.`
					}
				});
			}
			throw error;
		}

		if (headSha) {
			await octokit.rest.repos.createCommitStatus({
				owner,
				repo,
				sha: headSha,
				state: 'success',
				target_url: targetUrl,
				description: `Successfully uploaded artifact ${artifact.name} to S3.`,
				context: `${APP_NAME} / ${artifact.name}`
			});
		}
	}

	/**
	 * Processes a batch of SQS records concurrently and accumulates any batch item failures.
	 * @param records Array of SQS records to process
	 * @returns Array of failed batch item identifiers
	 */
	async processBatch(records: SQSRecord[]): Promise<BatchItemFailure[]> {
		const results = await Promise.all(
			records.map(async (record) => {
				try {
					await this.processRecord(record);
					return null;
				} catch (error) {
					this.probot.log.error(
						`Failed to process SQS record ${record.messageId}: ${errorToString(error)}`
					);
					return { itemIdentifier: record.messageId };
				}
			})
		);

		return results.filter((result): result is BatchItemFailure => result !== null);
	}
}
