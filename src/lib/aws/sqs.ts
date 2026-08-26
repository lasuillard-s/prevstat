import { S3Client } from '@aws-sdk/client-s3';
import { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { Probot, ProbotOctokit } from 'probot';
import type { AppConfig } from '../../config.js';
import { buildArtifactPath } from '../../utils/url.js';
import { downloadArtifact, unzipAndUpload } from '../github.js';

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
 * Processes an individual SQS record containing artifact processing information.
 * Throws an error if any step in processing fails.
 * @param record SQS record containing the message body
 * @param probot Probot instance for logging and installation auth
 * @param config Application configuration
 * @param s3Client S3 client for uploading artifacts
 */
export async function processArtifactRecord(
	record: SQSRecord,
	probot: Probot,
	config: AppConfig,
	s3Client: S3Client
): Promise<void> {
	const message: ProcessArtifactMessage = JSON.parse(record.body);
	const { installationId, owner, repo, runId, artifactId } = message;

	const octokit = (
		installationId ? await probot.auth(installationId) : await probot.auth()
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

	probot.log.info(
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
	const targetUrl = `https://${config.CLOUDFRONT_DOMAIN}${path}`;

	try {
		const zipBuffer = await downloadArtifact(octokit, owner, repo, artifact.id);
		await unzipAndUpload(
			zipBuffer,
			artifact.name,
			visibility,
			owner,
			repo,
			workflowRunId,
			config,
			s3Client,
			probot.log
		);
	} catch (error) {
		if (headSha) {
			await octokit.rest.checks.create({
				owner,
				repo,
				name: `Presta / ${artifact.name}`,
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
			context: `Presta / ${artifact.name}`
		});
	}
}
