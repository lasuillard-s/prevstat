import type { AppConfig } from '../config.js';

/**
 * Safely builds the base path for repository-scoped CloudFront signed cookies.
 * @param visibility The visibility of the artifact ('public' or 'private')
 * @param owner The repository owner
 * @param repo The repository name
 * @returns The safely built URL path for repository scope, starting with a slash
 */
export function buildRepositoryBasePath(visibility: string, owner: string, repo: string): string {
	const segments = [visibility, owner, repo].map(encodeURIComponent);
	return `/${segments.join('/')}`;
}

/**
 * Safely builds an artifact file URL path. All parameters are required.
 * @param visibility The visibility of the artifact ('public' or 'private')
 * @param owner The repository owner
 * @param repo The repository name
 * @param workflowRunId The workflow run ID
 * @param artifactName The artifact name
 * @param filePath The file path inside the artifact
 * @returns The safely built URL path, starting with a slash
 */
export function buildArtifactPath(
	visibility: string,
	owner: string,
	repo: string,
	workflowRunId: string | number,
	artifactName: string,
	filePath: string
): string {
	const baseSegments = [visibility, owner, repo, String(workflowRunId), artifactName].map(
		encodeURIComponent
	);
	const fileSegments = filePath.split('/').map(encodeURIComponent);
	return `/${[...baseSegments, ...fileSegments].join('/')}`;
}

/**
 * Validates that the document URI is a valid URL matching the configured CloudFront domain and private path.
 * @param uri The document URI to validate
 * @param config Application configuration
 * @returns True if valid, false otherwise
 */
export function isValidDocumentUri(uri: string, config: Readonly<AppConfig>): boolean {
	try {
		const parsedUrl = new URL(uri);
		const expectedHost = config.CLOUDFRONT_DOMAIN.replace(/^https?:\/\//, '').replace(/\/+$/, '');
		if (parsedUrl.host !== expectedHost) {
			return false;
		}
		if (!parsedUrl.pathname.startsWith('/private/')) {
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Parses the repository owner and name from an artifact document URL.
 * URL path must strictly match `/<visibility>/<owner>/<repo>/<workflowRunId>/<artifactName>/<filePath>`.
 * Throws an error if the URL is invalid or if any path component is missing.
 * @param url The artifact document URL
 * @returns The parsed repository owner and name
 */
export function parseRepoFromUrl(url: string): { owner: string; repo: string } {
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

	return {
		owner: decodeURIComponent(owner),
		repo: decodeURIComponent(repo)
	};
}
