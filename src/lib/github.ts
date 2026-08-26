import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import AdmZip from 'adm-zip';
import mime from 'mime-types';
import path from 'path';
import type { Probot, ProbotOctokit } from 'probot';
import { buildArtifactPath } from './url.js';

/**
 * Downloads GitHub Actions workflow artifacts.
 */
export class ArtifactDownloader {
	constructor(private readonly probot: Probot) {}

	/**
	 * Downloads an artifact zip archive from GitHub.
	 * @param owner Repository owner
	 * @param repo Repository name
	 * @param artifactId GitHub artifact ID
	 * @param installationId Optional GitHub App installation ID
	 * @returns Buffer containing the downloaded zip archive
	 */
	async download(
		owner: string,
		repo: string,
		artifactId: number,
		installationId?: number
	): Promise<Buffer> {
		const octokit = (
			installationId ? await this.probot.auth(installationId) : await this.probot.auth()
		) as ProbotOctokit;

		const download = await octokit.rest.actions.downloadArtifact({
			owner,
			repo,
			artifact_id: artifactId,
			archive_format: 'zip'
		});
		return Buffer.from(download.data as ArrayBuffer);
	}
}

/**
 * Target destination parameters for artifact upload.
 */
export interface ArtifactUploadTarget {
	owner: string;
	repo: string;
	workflowRunId: number;
	artifactName: string;
	visibility: 'private' | 'public';
}

/**
 * Unzips and uploads artifact files to AWS S3.
 */
export class ArtifactUploader {
	constructor(
		private readonly s3Client: S3Client,
		private readonly bucketName: string,
		private readonly log?: Probot['log']
	) {}

	/**
	 * Unzips artifact archive in-memory and uploads each file to S3.
	 * Skips directory entries and unsafe paths.
	 * @param zipBuffer Zip file buffer
	 * @param target Target repository and artifact metadata
	 */
	async upload(zipBuffer: Buffer, target: ArtifactUploadTarget): Promise<void> {
		const { owner, repo, workflowRunId, artifactName, visibility } = target;
		const zip = new AdmZip(zipBuffer);
		const zipEntries = zip.getEntries();

		const uploadPromises = zipEntries.map(async (entry) => {
			if (entry.isDirectory) return;

			const safeEntryName = sanitizeZipEntryPath(entry.entryName);
			if (!safeEntryName) {
				this.log?.warn(
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

			await this.s3Client.send(
				new PutObjectCommand({
					Bucket: this.bucketName,
					Key: s3Key,
					Body: entry.getData(),
					ContentType: contentType
				})
			);
		});

		await Promise.all(uploadPromises);
	}
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
