import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import AdmZip from 'adm-zip';
import mime from 'mime-types';
import { Context } from 'probot';
import { buildArtifactPath } from '../assets.js';
import { AppConfig } from '../config.js';
import { matchPatterns } from '../utils.js';
import { BaseHandler } from './base.js';

/**
 * Handler for workflow run completed events on the runner repository.
 */
export default class WorkflowRunCompletedHandler extends BaseHandler<
	Context<'workflow_run.completed'>
> {
	private readonly s3Client: S3Client;

	constructor(
		context: Context<'workflow_run.completed'>,
		appConfig: AppConfig,
		s3Client?: S3Client
	) {
		super(context, appConfig);
		this.s3Client = s3Client ?? new S3Client({});
	}

	private get visibility(): 'private' | 'public' {
		return this.context.payload.repository.private ? 'private' : 'public';
	}

	async handle() {
		const { payload } = this.context;

		this.log.debug(
			`Received workflow run completed event from repository ${payload.repository.full_name}, workflow ${payload.workflow_run.name}.`
		);

		const artifacts = await this.listArtifacts();
		const processPromises = artifacts.map(async (artifact) => {
			const artifactFqn = `${payload.repository.full_name}:${payload.workflow_run.name}:${artifact.name}`;
			if (this.isArtifactMatched(artifactFqn)) {
				this.log.info(`Artifact matched: ${artifactFqn}. Processing...`);
				await this.processArtifact(artifact);
			}
		});
		await Promise.all(processPromises);
	}

	private async listArtifacts() {
		const { payload, octokit } = this.context;
		const { owner, repo } = this.repo();
		try {
			const { data } = await octokit.rest.actions.listWorkflowRunArtifacts({
				owner,
				repo,
				run_id: payload.workflow_run.id
			});
			return data.artifacts;
		} catch (error) {
			this.log.error(error, `Failed to list artifacts for workflow run ${payload.workflow_run.id}`);
			return [];
		}
	}

	private isArtifactMatched(artifactFqn: string): boolean {
		return matchPatterns(artifactFqn, this.appConfig.ARTIFACT_PATTERNS, {});
	}

	// Process a single artifact: download, unzip, upload to S3, and create a check run.
	private async processArtifact(artifact: { id: number; name: string }) {
		const zipBuffer = await this.downloadArtifact(artifact.id);
		if (!zipBuffer) {
			this.log.error(`Failed to download artifact ${artifact.name}. Skipping processing.`);
			return;
		}
		const success = await this.unzipAndUpload(zipBuffer, artifact.name);
		await this.createCheckRun(artifact.name, success ? 'success' : 'failure');
	}

	private async downloadArtifact(artifactId: number): Promise<Buffer | null> {
		const { octokit } = this.context;
		const { owner, repo } = this.repo();
		try {
			const download = await octokit.rest.actions.downloadArtifact({
				owner,
				repo,
				artifact_id: artifactId,
				archive_format: 'zip'
			});
			return Buffer.from(download.data as ArrayBuffer);
		} catch (error) {
			this.log.error(error, `Failed to download artifact ${artifactId}`);
			return null;
		}
	}

	private async unzipAndUpload(zipBuffer: Buffer, artifactName: string): Promise<boolean> {
		const { payload } = this.context;
		const { owner, repo } = this.repo();

		let zip: AdmZip;
		try {
			zip = new AdmZip(zipBuffer);
		} catch (error) {
			this.log.error(error, `Failed to read zip archive for artifact ${artifactName}`);
			return false;
		}

		const zipEntries = zip.getEntries();
		let hasError = false;

		const uploadPromises = zipEntries.map(async (entry) => {
			if (entry.isDirectory) return;

			// Use the buildArtifactPath to build the key, removing the leading slash for S3 key
			const path = buildArtifactPath(
				this.visibility,
				owner,
				repo,
				payload.workflow_run.id,
				artifactName,
				entry.entryName
			);
			const s3Key = path.startsWith('/') ? path.substring(1) : path;

			const contentType = mime.lookup(entry.entryName) || 'application/octet-stream';

			try {
				await this.s3Client.send(
					new PutObjectCommand({
						Bucket: this.appConfig.S3_BUCKET_NAME,
						Key: s3Key,
						Body: entry.getData(),
						ContentType: contentType
					})
				);
			} catch (error) {
				hasError = true;
				this.log.error(error, `Failed to upload ${entry.entryName} to S3`);
			}
		});

		await Promise.all(uploadPromises);
		if (hasError) {
			this.log.error(`Some files failed to upload for artifact ${artifactName}.`);
			return false;
		}

		this.log.info(`Uploaded all files from artifact ${artifactName} to S3.`);
		return true;
	}

	private async createCheckRun(
		artifactName: string,
		conclusion: 'success' | 'failure' = 'success'
	) {
		const { payload, octokit } = this.context;
		const { owner, repo } = this.repo();

		// Determine the details URL (could be CloudFront domain root + path)
		// Assuming index.html is the entry point
		const basePath = buildArtifactPath(
			this.visibility,
			owner,
			repo,
			payload.workflow_run.id,
			artifactName
		);
		const detailsUrl = `https://${this.appConfig.CLOUDFRONT_DOMAIN}${basePath}/index.html`;
		const summary =
			conclusion === 'success'
				? `Successfully uploaded artifact ${artifactName} to S3.`
				: `Failed to upload artifact ${artifactName} to S3.`;

		try {
			await octokit.rest.checks.create({
				owner,
				repo,
				name: artifactName,
				head_sha: payload.workflow_run.head_sha,
				status: 'completed',
				conclusion,
				details_url: detailsUrl,
				output: {
					title: `Artifact: ${artifactName}`,
					summary
				}
			});
			this.log.info(
				`Created check run for artifact ${artifactName} with conclusion '${conclusion}'.`
			);
		} catch (error) {
			this.log.error(error, `Failed to create check run for artifact ${artifactName}`);
		}
	}
}
