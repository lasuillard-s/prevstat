import { Probot } from 'probot';
import { beforeEach, describe, expect, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { test as it } from './helpers.js';

describe('loadConfig', () => {
	let probot: Probot;

	beforeEach(() => {
		probot = {
			log: {
				error: vi.fn()
			}
		} as unknown as Probot;
	});

	it('loads valid config with reasonable defaults', () => {
		// Arrange (required only)
		vi.stubEnv('GITHUB_CLIENT_ID', 'test-client-id');
		vi.stubEnv('GITHUB_CLIENT_SECRET', 'test-client-secret');
		vi.stubEnv('CLOUDFRONT_DOMAIN', 'https://test.cloudfront.net');
		vi.stubEnv('CLOUDFRONT_PRIVATE_KEY', 'test-private-key');
		vi.stubEnv('CLOUDFRONT_KEY_PAIR_ID', 'test-key-pair-id');
		vi.stubEnv('JWT_SECRET', 'test-jwt-secret');
		vi.stubEnv('S3_BUCKET_NAME', 'test-bucket');
		vi.stubEnv('ARTIFACT_PATTERNS', 'owner/repo:workflow:artifact, another/repo:*:*');

		// Act & Assert
		const config = loadConfig(probot);
		expect(config).toMatchObject({
			GITHUB_CLIENT_ID: 'test-client-id',
			GITHUB_CLIENT_SECRET: 'test-client-secret',
			CLOUDFRONT_DOMAIN: 'https://test.cloudfront.net',
			CLOUDFRONT_PRIVATE_KEY: 'test-private-key',
			CLOUDFRONT_KEY_PAIR_ID: 'test-key-pair-id',
			CLOUDFRONT_SIGNED_COOKIE_EXPIRATION_SECONDS: 900,
			JWT_SECRET: 'test-jwt-secret',
			JWT_EXPIRATION_SECONDS: 300,
			S3_BUCKET_NAME: 'test-bucket',
			ARTIFACT_PATTERNS: ['owner/repo:workflow:artifact', 'another/repo:*:*']
		});
	});

	it('loads valid config with explicit configuration values', () => {
		// Arrange
		vi.stubEnv('GITHUB_CLIENT_ID', 'custom-client-id');
		vi.stubEnv('GITHUB_CLIENT_SECRET', 'custom-client-secret');
		vi.stubEnv('CLOUDFRONT_DOMAIN', 'https://custom.cloudfront.net');
		vi.stubEnv('CLOUDFRONT_PRIVATE_KEY', 'custom-private-key');
		vi.stubEnv('CLOUDFRONT_KEY_PAIR_ID', 'custom-key-pair-id');
		vi.stubEnv('JWT_SECRET', 'custom-jwt-secret');
		vi.stubEnv('S3_BUCKET_NAME', 'custom-bucket');
		vi.stubEnv('ARTIFACT_PATTERNS', 'custom/repo:*:*');

		// Act & Assert
		const config = loadConfig(probot);
		expect(config).toMatchObject({
			GITHUB_CLIENT_ID: 'custom-client-id',
			GITHUB_CLIENT_SECRET: 'custom-client-secret',
			CLOUDFRONT_DOMAIN: 'https://custom.cloudfront.net',
			CLOUDFRONT_PRIVATE_KEY: 'custom-private-key',
			CLOUDFRONT_KEY_PAIR_ID: 'custom-key-pair-id',
			JWT_SECRET: 'custom-jwt-secret',
			S3_BUCKET_NAME: 'custom-bucket',
			ARTIFACT_PATTERNS: ['custom/repo:*:*']
		});
	});

	it('exits process when required configuration is missing', () => {
		const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

		loadConfig(probot);

		expect(probot.log.error).toHaveBeenCalled();
		expect(exitSpy).toHaveBeenCalledWith(1);
	});
});
