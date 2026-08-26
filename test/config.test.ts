import { describe, expect, it, vi } from 'vitest';
import { AppConfig } from '../src/config.js';

describe('AppConfig', () => {
	it('loads valid config with reasonable defaults', () => {
		// Arrange (required only)
		vi.stubEnv('GITHUB_CLIENT_ID', 'test-client-id');
		vi.stubEnv('GITHUB_CLIENT_SECRET', 'test-client-secret');
		vi.stubEnv('CLOUDFRONT_DOMAIN', 'https://test.cloudfront.net');
		vi.stubEnv('CLOUDFRONT_PRIVATE_KEY', 'test-private-key');
		vi.stubEnv('CLOUDFRONT_KEY_PAIR_ID', 'test-key-pair-id');
		vi.stubEnv('JWT_SECRET', 'test-jwt-secret');
		vi.stubEnv('S3_BUCKET_NAME', 'test-bucket');
		vi.stubEnv('SQS_QUEUE_URL', 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue');
		vi.stubEnv(
			'ARTIFACT_PATTERNS',
			'owner/repo:.github/workflows/ci.yaml:artifact, another/repo:*:*'
		);

		// Act & Assert
		const config = AppConfig.parse(process.env);
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
			SQS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue',
			ARTIFACT_PATTERNS: ['owner/repo:.github/workflows/ci.yaml:artifact', 'another/repo:*:*']
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
		vi.stubEnv('SQS_QUEUE_URL', 'https://sqs.us-east-1.amazonaws.com/123456789012/custom-queue');
		vi.stubEnv('ARTIFACT_PATTERNS', 'custom/repo:*:*');

		// Act & Assert
		const config = AppConfig.parse(process.env);
		expect(config).toMatchObject({
			GITHUB_CLIENT_ID: 'custom-client-id',
			GITHUB_CLIENT_SECRET: 'custom-client-secret',
			CLOUDFRONT_DOMAIN: 'https://custom.cloudfront.net',
			CLOUDFRONT_PRIVATE_KEY: 'custom-private-key',
			CLOUDFRONT_KEY_PAIR_ID: 'custom-key-pair-id',
			JWT_SECRET: 'custom-jwt-secret',
			S3_BUCKET_NAME: 'custom-bucket',
			SQS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/custom-queue',
			ARTIFACT_PATTERNS: ['custom/repo:*:*']
		});
	});

	it('filters out empty entries in ARTIFACT_PATTERNS', () => {
		// Arrange
		vi.stubEnv('GITHUB_CLIENT_ID', 'test-client-id');
		vi.stubEnv('GITHUB_CLIENT_SECRET', 'test-client-secret');
		vi.stubEnv('CLOUDFRONT_DOMAIN', 'https://test.cloudfront.net');
		vi.stubEnv('CLOUDFRONT_PRIVATE_KEY', 'test-private-key');
		vi.stubEnv('CLOUDFRONT_KEY_PAIR_ID', 'test-key-pair-id');
		vi.stubEnv('JWT_SECRET', 'test-jwt-secret');
		vi.stubEnv('S3_BUCKET_NAME', 'test-bucket');
		vi.stubEnv('SQS_QUEUE_URL', 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue');
		vi.stubEnv('ARTIFACT_PATTERNS', 'owner/repo:*:artifact, , another/repo:*:*, ');

		// Act
		const config = AppConfig.parse(process.env);

		// Assert
		expect(config.ARTIFACT_PATTERNS).toEqual(['owner/repo:*:artifact', 'another/repo:*:*']);
	});

	it('throws an error when required configuration is missing', () => {
		expect(() => AppConfig.parse({})).toThrow();
	});
});
