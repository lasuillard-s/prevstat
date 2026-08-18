import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import AdmZip from 'adm-zip';
import express, { Request, Response } from 'express';
import mime from 'mime-types';
import type { Probot, ProbotOctokit } from 'probot';
import { buildArtifactPath } from '../../assets.js';
import type { AppConfig } from '../../config.js';
import type { ProcessArtifactMessage } from '../../sqs.js';
import { errorToString } from '../../utils.js';

export const router = express.Router();

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

let defaultS3Client: S3Client | undefined;

/**
 * Resolves the S3Client from Express locals or creates a default singleton instance.
 * @param req Express request object
 * @returns S3Client instance
 */
function getS3Client(req: Request<Record<string, string>, unknown, SQSEvent>): S3Client {
	return (req.app.locals.s3Client as S3Client) ?? (defaultS3Client ??= new S3Client({}));
}

router.post('/', async (req: Request<Record<string, string>, unknown, SQSEvent>, res: Response) => {
	const probot = req.app.locals.probot as Probot;
	const config = req.app.locals.config as AppConfig;
	const s3Client = getS3Client(req);

	const records = req.body.Records ?? [];
	const batchItemFailures: BatchItemFailure[] = [];

	for (const record of records) {
		try {
			await processRecord(record, probot, config, s3Client);
		} catch (error) {
			probot.log.error(`Failed to process SQS record ${record.messageId}: ${errorToString(error)}`);
			batchItemFailures.push({ itemIdentifier: record.messageId });
		}
	}

	res.status(200).json({ batchItemFailures });
});

/**
 * Processes an individual SQS record containing artifact processing information.
 * @param record SQS record containing the message body
 * @param probot Probot instance for logging and installation auth
 * @param config Application configuration
 * @param s3Client S3 client for uploading artifacts
 */
async function processRecord(
	record: SQSRecord,
	probot: Probot,
	config: AppConfig,
	s3Client: S3Client
): Promise<void> {
	const message: ProcessArtifactMessage = JSON.parse(record.body);
	const { repository, workflowRun, artifact, installationId } = message;

	const owner = repository.owner.login;
	const repo = repository.name;
	const visibility = repository.private ? 'private' : 'public';

	const octokit = (
		installationId ? await probot.auth(installationId) : await probot.auth()
	) as ProbotOctokit;

	probot.log.info(
		`Processing artifact ${artifact.name} (id: ${artifact.id}) for ${owner}/${repo} workflow run ${workflowRun.id}`
	);

	const basePath = buildArtifactPath(visibility, owner, repo, workflowRun.id, artifact.name);
	const targetUrl = `https://${config.CLOUDFRONT_DOMAIN}${basePath}/index.html`;

	const zipBuffer = await downloadArtifact(octokit, owner, repo, artifact.id, probot);
	if (!zipBuffer) {
		probot.log.error(
			`Failed to download artifact ${artifact.name} (id: ${artifact.id}). Reporting failure.`
		);
		await octokit.rest.checks.create({
			owner,
			repo,
			name: artifact.name,
			head_sha: workflowRun.head_sha,
			status: 'completed',
			conclusion: 'failure',
			details_url: targetUrl,
			output: {
				title: `Artifact: ${artifact.name}`,
				summary: `Failed to upload artifact ${artifact.name} to S3.`
			}
		});
		return;
	}

	const success = await unzipAndUpload(
		zipBuffer,
		artifact.name,
		visibility,
		owner,
		repo,
		workflowRun.id,
		config,
		s3Client,
		probot
	);

	if (success) {
		await octokit.rest.repos.createCommitStatus({
			owner,
			repo,
			sha: workflowRun.head_sha,
			state: 'success',
			target_url: targetUrl,
			description: `Successfully uploaded artifact ${artifact.name} to S3.`,
			context: artifact.name
		});
	} else {
		await octokit.rest.checks.create({
			owner,
			repo,
			name: artifact.name,
			head_sha: workflowRun.head_sha,
			status: 'completed',
			conclusion: 'failure',
			details_url: targetUrl,
			output: {
				title: `Artifact: ${artifact.name}`,
				summary: `Failed to upload artifact ${artifact.name} to S3.`
			}
		});
	}
}

/**
 * Downloads artifact zip buffer from GitHub.
 * @param octokit Authenticated Octokit client
 * @param owner Repository owner
 * @param repo Repository name
 * @param artifactId GitHub artifact ID
 * @param probot Probot instance for logging
 * @returns ArrayBuffer converted to Buffer or null on failure
 */
async function downloadArtifact(
	octokit: ProbotOctokit,
	owner: string,
	repo: string,
	artifactId: number,
	probot: Probot
): Promise<Buffer | null> {
	try {
		const download = await octokit.rest.actions.downloadArtifact({
			owner,
			repo,
			artifact_id: artifactId,
			archive_format: 'zip'
		});
		return Buffer.from(download.data as ArrayBuffer);
	} catch (error) {
		probot.log.error(`Failed to download artifact ${artifactId}: ${errorToString(error)}`);
		return null;
	}
}

/**
 * Extracts a zip archive buffer and uploads each file to S3.
 * @param zipBuffer Buffer containing the zipped artifact
 * @param artifactName Name of the artifact
 * @param visibility Visibility of the repository ('private' | 'public')
 * @param owner Repository owner
 * @param repo Repository name
 * @param workflowRunId GitHub workflow run ID
 * @param config Application configuration
 * @param s3Client S3 client for file upload
 * @param probot Probot instance for logging
 * @returns True if all files were uploaded successfully, false otherwise
 */
async function unzipAndUpload(
	zipBuffer: Buffer,
	artifactName: string,
	visibility: 'private' | 'public',
	owner: string,
	repo: string,
	workflowRunId: number,
	config: AppConfig,
	s3Client: S3Client,
	probot: Probot
): Promise<boolean> {
	let zip: AdmZip;
	try {
		zip = new AdmZip(zipBuffer);
	} catch (error) {
		probot.log.error(
			`Failed to read zip archive for artifact ${artifactName}: ${errorToString(error)}`
		);
		return false;
	}

	const zipEntries = zip.getEntries();
	let hasError = false;

	const uploadPromises = zipEntries.map(async (entry) => {
		if (entry.isDirectory) return;

		const path = buildArtifactPath(
			visibility,
			owner,
			repo,
			workflowRunId,
			artifactName,
			entry.entryName
		);
		const s3Key = path.startsWith('/') ? path.substring(1) : path;
		const contentType = mime.lookup(entry.entryName) || 'application/octet-stream';

		try {
			await s3Client.send(
				new PutObjectCommand({
					Bucket: config.S3_BUCKET_NAME,
					Key: s3Key,
					Body: entry.getData(),
					ContentType: contentType
				})
			);
		} catch (error) {
			hasError = true;
			probot.log.error(`Failed to upload ${entry.entryName} to S3: ${errorToString(error)}`);
		}
	});

	await Promise.all(uploadPromises);
	if (hasError) {
		probot.log.error(`Some files failed to upload for artifact ${artifactName}.`);
		return false;
	}

	probot.log.info(`Uploaded all files from artifact ${artifactName} to S3.`);
	return true;
}
