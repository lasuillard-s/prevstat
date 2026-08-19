/**
 * Safely builds the base path for repository-scoped CloudFront signed cookies.
 * @param visibility The visibility of the artifact ('public' or 'private')
 * @param owner The repository owner
 * @param repo The repository name
 * @returns The safely built URL path for repository scope, starting with a slash
 */
export function buildRepositoryBasePath(visibility: string, owner: string, repo: string): string {
	return `/${encodeURIComponent(visibility)}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
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
	const safeFilePath = filePath
		.split('/')
		.map((p) => encodeURIComponent(p))
		.join('/');

	return `/${encodeURIComponent(visibility)}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(String(workflowRunId))}/${encodeURIComponent(artifactName)}/${safeFilePath}`;
}
