import { describe, expect, it } from 'vitest';
import { buildArtifactPath, buildRepositoryBasePath } from '../src/assets.js';

describe('buildRepositoryBasePath', () => {
	it('builds a repository-scoped base path', () => {
		expect(buildRepositoryBasePath('private', 'owner', 'repo')).toBe('/private/owner/repo');
	});

	it('safely encodes repository owner and repo components', () => {
		expect(buildRepositoryBasePath('private', 'owner/name', 'repo:name')).toBe(
			'/private/owner%2Fname/repo%3Aname'
		);
	});
});

describe('buildArtifactPath', () => {
	it('builds a full artifact file path with all required arguments', () => {
		expect(
			buildArtifactPath('private', 'owner', 'repo', 123, 'artifact-name', 'dir/index.html')
		).toBe('/private/owner/repo/123/artifact-name/dir/index.html');
	});

	it('safely encodes components while preserving file path segments', () => {
		expect(
			buildArtifactPath('private', 'owner/name', 'repo', 123, 'artifact/name', '../etc/passwd')
		).toBe('/private/owner%2Fname/repo/123/artifact%2Fname/../etc/passwd');
	});
});
