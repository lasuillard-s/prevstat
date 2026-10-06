import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import AdmZip from 'adm-zip';
import mime from 'mime-types';
import type { Context, ProbotOctokit } from 'probot';
import { SafeAdmZip } from '../utils/zip.js';
import { buildArtifactPath } from './url.js';

/**
 * Encapsulates repository owner and name with helper methods.
 */
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
		if (!owner || !repo) {
			throw new Error(`Invalid repository full name: ${fullName}`);
		}
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
	 * Parses the repository owner and name from an artifact document URL.
	 * URL path must strictly match `/<visibility>/<owner>/<repo>/<workflowRunId>/<artifactName>/<filePath>`.
	 * Throws an error if the URL is invalid or if any path component is missing.
	 * @param url The artifact document URL
	 * @returns The parsed Repo
	 */
	static fromUrl(url: string): Repo {
		const parsedUrl = new URL(url);
		const parts = parsedUrl.pathname.split('/');

		// Expect ['', visibility, owner, repo, workflowRunId, artifactName, ...filePathParts]
		if (parts.length < 7) {
			throw new Error(`Incomplete artifact path in URL: ${url}`);
		}

		// Extract the required components from the URL path
		const [, visibility, owner, repo, workflowRunId, artifactName, ...filePathParts] = parts;
		const filePath = filePathParts.join('/');

		// Validate that all required components are present
		if (!visibility || !owner || !repo || !workflowRunId || !artifactName || !filePath) {
			throw new Error(
				`Missing required path components in URL (${url}): ${JSON.stringify({ visibility, owner, repo, workflowRunId, artifactName, filePath })}`
			);
		}

		return new Repo(decodeURIComponent(owner), decodeURIComponent(repo));
	}

	/**
	 * Returns the `owner/repo` full name of the repository.
	 * @returns The full name in `owner/repo` format
	 */
	toString(): string {
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
 * Downloads GitHub Actions workflow artifacts.
 */
export class ArtifactDownloader {
	constructor(private readonly octokit: ProbotOctokit) {}

	/**
	 * Downloads an artifact zip archive from GitHub.
	 * @param owner Repository owner
	 * @param repo Repository name
	 * @param artifactId GitHub artifact ID
	 * @returns Buffer containing the downloaded zip archive
	 */
	async download(owner: string, repo: string, artifactId: number): Promise<SafeAdmZip> {
		const download = await this.octokit.rest.actions.downloadArtifact({
			owner,
			repo,
			artifact_id: artifactId,
			archive_format: 'zip'
		});
		const buffer = Buffer.from(download.data as ArrayBuffer);
		const zip = new AdmZip(buffer);
		return new SafeAdmZip(zip);
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
		private readonly bucketName: string
	) {}

	/**
	 * Unzips artifact archive in-memory and uploads each file to S3.
	 * Skips directory entries and unsafe paths.
	 * @param zip The SafeAdmZip instance representing the artifact zip archive
	 * @param target Target repository and artifact metadata
	 */
	async upload(zip: SafeAdmZip, target: ArtifactUploadTarget): Promise<void> {
		const { owner, repo, workflowRunId, artifactName, visibility } = target;
		const s3Commands: Array<PutObjectCommand> = [];

		for (const entry of zip.getEntries()) {
			if (entry.isDirectory) continue;

			const path = buildArtifactPath(
				visibility,
				owner,
				repo,
				workflowRunId,
				artifactName,
				entry.entryName
			);
			const contentType = mime.lookup(entry.entryName) || 'application/octet-stream';

			// Remove leading slash from the path to form the S3 key
			const s3Key = path.startsWith('/') ? path.substring(1) : path;

			s3Commands.push(
				new PutObjectCommand({
					Bucket: this.bucketName,
					Key: s3Key,
					Body: entry.getData(),
					ContentType: contentType
				})
			);
		}

		// Upload S3 commands in chunks to avoid overwhelming the S3 service
		const chunkSize = 50;
		for (let i = 0; i < s3Commands.length; i += chunkSize) {
			await Promise.all(
				s3Commands.slice(i, i + chunkSize).map((command) => this.s3Client.send(command))
			);
		}
	}
}
