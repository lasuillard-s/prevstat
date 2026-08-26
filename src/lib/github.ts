import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import AdmZip from 'adm-zip';
import mime from 'mime-types';
import path from 'path';
import type { Context, Probot, ProbotOctokit } from 'probot';
import type { AppConfig } from '../config.js';
import { buildArtifactPath } from '../utils/url.js';

export class Repo {
	constructor(
		public readonly owner: string,
		public readonly repo: string
	) {}

	/**
	 * Parses a repository full name in `owner/repo` format into a Repo.
	 * @param fullName Repository full name
	 * @returns The parsed Repo
	 */
	static fromFullName(fullName: string): Repo {
		const [owner, repo] = fullName.split('/');
		return new Repo(owner, repo);
	}

	/**
	 * Creates a Repo from a Probot event context.
	 * @param context Event context that exposes the repository helper
	 * @returns The Repo for the event's repository
	 */
	static fromContext(context: Context): Repo {
		const { owner, repo } = context.repo();
		return new Repo(owner, repo);
	}

	/**
	 * Returns the `owner/repo` full name of the repository.
	 * @returns The full name in `owner/repo` format
	 */
	toFullName(): string {
		return `${this.owner}/${this.repo}`;
	}

	/**
	 * Checks if this repository equals another by owner and repo.
	 * @param other The repository to compare with
	 * @returns True if both owner and repo match
	 */
	equals(other: Repo): boolean {
		return this.owner === other.owner && this.repo === other.repo;
	}
}

/**
 * Downloads artifact zip buffer from GitHub.
 * @param octokit Authenticated Octokit client
 * @param owner Repository owner
 * @param repo Repository name
 * @param artifactId GitHub artifact ID
 * @returns ArrayBuffer converted to Buffer
 */
export async function downloadArtifact(
	octokit: ProbotOctokit,
	owner: string,
	repo: string,
	artifactId: number
): Promise<Buffer> {
	const download = await octokit.rest.actions.downloadArtifact({
		owner,
		repo,
		artifact_id: artifactId,
		archive_format: 'zip'
	});
	return Buffer.from(download.data as ArrayBuffer);
}

/**
 * Safely sanitizes a zip entry name by normalizing separators, removing leading slashes,
 * and rejecting path traversal (e.g. `..`).
 * @param entryName The entry name from the zip archive
 * @returns The sanitized safe relative path, or null if invalid or unsafe
 */
export function sanitizeZipEntryPath(entryName: string): string | null {
	const normalized = entryName.replace(/\\/g, '/');
	const posixNormalized = path.posix.normalize(normalized);
	const cleanPath = posixNormalized.replace(/^\/+/, '');

	if (
		!cleanPath ||
		cleanPath === '.' ||
		cleanPath.startsWith('../') ||
		cleanPath === '..' ||
		cleanPath.split('/').includes('..')
	) {
		return null;
	}

	return cleanPath;
}

/**
 * Downloads artifact, unzips it in-memory, and uploads each file to S3.
 * Skips directory entries and unsafe paths.
 * @param zipBuffer Zip file buffer
 * @param artifactName Name of the artifact
 * @param visibility Visibility of the repository ('private' | 'public')
 * @param owner Repository owner
 * @param repo Repository name
 * @param workflowRunId GitHub workflow run ID
 * @param config Application configuration
 * @param s3Client S3 client for file upload
 * @param log Optional logger instance
 */
export async function unzipAndUpload(
	zipBuffer: Buffer,
	artifactName: string,
	visibility: 'private' | 'public',
	owner: string,
	repo: string,
	workflowRunId: number,
	config: AppConfig,
	s3Client: S3Client,
	log: Probot['log']
): Promise<void> {
	const zip = new AdmZip(zipBuffer);
	const zipEntries = zip.getEntries();

	const uploadPromises = zipEntries.map(async (entry) => {
		if (entry.isDirectory) return;

		const safeEntryName = sanitizeZipEntryPath(entry.entryName);
		if (!safeEntryName) {
			log?.warn(
				`Skipping unsafe or invalid zip entry path: "${entry.entryName}" in artifact ${artifactName}`
			);
			return;
		}

		const path = buildArtifactPath(
			visibility,
			owner,
			repo,
			workflowRunId,
			artifactName,
			safeEntryName
		);
		const s3Key = path.startsWith('/') ? path.substring(1) : path;
		const contentType = mime.lookup(safeEntryName) || 'application/octet-stream';

		await s3Client.send(
			new PutObjectCommand({
				Bucket: config.S3_BUCKET_NAME,
				Key: s3Key,
				Body: entry.getData(),
				ContentType: contentType
			})
		);
	});

	await Promise.all(uploadPromises);
}
