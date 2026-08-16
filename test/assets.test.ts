import { describe, expect } from 'vitest';
import { buildArtifactPath } from '../src/assets.js';
import { test as it } from './helpers.js';

describe('buildArtifactPath', () => {
	it('builds a path with base parameters', () => {
		expect(buildArtifactPath('private', 'owner', 'repo')).toBe('/private/owner/repo');
	});

	it('builds a path with workflowRunId and artifactName', () => {
		expect(buildArtifactPath('private', 'owner', 'repo', 123, 'artifact-name')).toBe(
			'/private/owner/repo/123/artifact-name'
		);
	});

	it('builds a path with a specific file path', () => {
		expect(
			buildArtifactPath('private', 'owner', 'repo', 123, 'artifact-name', 'dir/index.html')
		).toBe('/private/owner/repo/123/artifact-name/dir/index.html');
	});

	it('safely encodes components to prevent path traversal', () => {
		expect(
			buildArtifactPath('private', 'owner/name', 'repo', 123, 'artifact/name', '../etc/passwd')
		).toBe('/private/owner%2Fname/repo/123/artifact%2Fname/../etc/passwd');
	});
});
