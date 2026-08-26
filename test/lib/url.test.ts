import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/config.js';
import {
	buildArtifactPath,
	buildRepositoryBasePath,
	isValidDocumentUri,
	parseRepoFromUrl
} from '../../src/lib/url.js';

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

describe('parseRepoFromUrl', () => {
	it('parses owner and repo from a complete artifact URL', () => {
		const result = parseRepoFromUrl(
			'https://assets.example.com/private/my-org/my-repo/123/build-output/index.html'
		);
		expect(result).toEqual({ owner: 'my-org', repo: 'my-repo' });
	});

	it('parses URL-encoded owner and repo correctly', () => {
		const result = parseRepoFromUrl(
			'https://assets.example.com/private/my%2Dorg/my%2Drepo/123/build-output/sub/dir/index.html'
		);
		expect(result).toEqual({ owner: 'my-org', repo: 'my-repo' });
	});

	it('throws an error for incomplete path patterns', () => {
		// Missing filePath
		expect(() =>
			parseRepoFromUrl('https://assets.example.com/private/my-org/my-repo/123/build-output')
		).toThrow('Incomplete artifact path in URL');

		// Missing artifactName
		expect(() => parseRepoFromUrl('https://assets.example.com/private/my-org/my-repo/123')).toThrow(
			'Incomplete artifact path in URL'
		);

		// Missing workflowRunId
		expect(() => parseRepoFromUrl('https://assets.example.com/private/my-org/my-repo')).toThrow(
			'Incomplete artifact path in URL'
		);

		// Missing repo
		expect(() => parseRepoFromUrl('https://assets.example.com/private/my-org')).toThrow(
			'Incomplete artifact path in URL'
		);
	});

	it('throws an error if any required component is empty', () => {
		expect(() =>
			parseRepoFromUrl('https://assets.example.com/private//my-repo/123/build-output/index.html')
		).toThrow('Missing required path components in URL');
	});

	it('throws an error for invalid URL string', () => {
		expect(() => parseRepoFromUrl('invalid-url')).toThrow();
	});
});

describe('isValidDocumentUri', () => {
	const mockConfig = {
		CLOUDFRONT_DOMAIN: 'assets.example.com'
	} as AppConfig;

	it('returns true for valid CloudFront private document URIs', () => {
		expect(
			isValidDocumentUri(
				'https://assets.example.com/private/my-org/my-repo/123/build-output/index.html',
				mockConfig
			)
		).toBe(true);
	});

	it('returns false for foreign domains', () => {
		expect(
			isValidDocumentUri(
				'https://attacker.com/private/my-org/my-repo/123/build-output/index.html',
				mockConfig
			)
		).toBe(false);
	});

	it('returns false for non-private paths', () => {
		expect(
			isValidDocumentUri(
				'https://assets.example.com/public/my-org/my-repo/123/build-output/index.html',
				mockConfig
			)
		).toBe(false);
		expect(isValidDocumentUri('https://assets.example.com/api/auth', mockConfig)).toBe(false);
	});

	it('returns false for malformed URLs', () => {
		expect(isValidDocumentUri('not-a-url', mockConfig)).toBe(false);
	});
});
