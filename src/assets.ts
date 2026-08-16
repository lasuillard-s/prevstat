/**
 * Safely builds an artifact URL path.
 * @param visibility The visibility of the artifact ('public' or 'private')
 * @param owner The repository owner
 * @param repo The repository name
 * @param workflowRunId The workflow run ID
 * @param artifactName The artifact name
 * @param filePath The file path inside the artifact (default: '')
 * @returns The safely built URL path, starting with a slash
 */
export function buildArtifactPath(
	visibility: string,
	owner: string,
	repo: string,
	workflowRunId?: string | number,
	artifactName?: string,
	filePath = ''
): string {
	const parts = [
		'', // leading slash
		encodeURIComponent(visibility),
		encodeURIComponent(owner),
		encodeURIComponent(repo)
	];

	if (workflowRunId !== undefined) {
		parts.push(encodeURIComponent(String(workflowRunId)));
		if (artifactName !== undefined) {
			parts.push(encodeURIComponent(artifactName));
			if (filePath) {
				const safeFilePath = filePath
					.split('/')
					.map((p) => encodeURIComponent(p))
					.join('/');
				parts.push(safeFilePath);
			}
		}
	}

	return parts.join('/');
}
