import type { Context } from 'probot';
import { describe, expect, it, vi } from 'vitest';
import { AppConfig } from '../../src/config.js';
import { BaseHandler } from '../../src/event-handlers/base.js';

/**
 * Minimal concrete subclass used to exercise the shared helpers on BaseHandler.
 */
class TestHandler extends BaseHandler<Context> {
	public handleCalled = false;

	constructor(config: AppConfig, payload: unknown = {}) {
		const context = {
			log: {
				debug: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn()
			},
			payload
		} as unknown as Context;
		super(context, config);
	}

	async handle(): Promise<void> {
		this.handleCalled = true;
	}
}

describe('BaseHandler.getPrincipal', () => {
	const baseConfig = AppConfig.parse({
		GITHUB_CLIENT_ID: 'client-id',
		GITHUB_CLIENT_SECRET: 'client-secret',
		CLOUDFRONT_DOMAIN: 'assets.example.com',
		CLOUDFRONT_PRIVATE_KEY: 'key',
		CLOUDFRONT_KEY_PAIR_ID: 'key-pair-id',
		CLOUDFRONT_SIGNED_COOKIE_EXPIRATION_SECONDS: 900,
		JWT_SECRET: 'jwt-secret',
		JWT_EXPIRATION_SECONDS: 300,
		S3_BUCKET_NAME: 'test-bucket',
		SQS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue',
		ARTIFACT_PATTERNS: 'my-org/my-repo:.github/workflows/ci.yaml:build-output*'
	});

	it('returns null when payload has no recognizable account login', () => {
		const handler = new TestHandler(baseConfig, {});
		expect(handler.getPrincipal()).toBeNull();
	});

	it('returns null when account login is not a string or missing', () => {
		const handler = new TestHandler(baseConfig, { installation: { account: {} } });
		expect(handler.getPrincipal()).toBeNull();
	});

	it('returns lowercase login of the installation account', () => {
		const handler = new TestHandler(baseConfig, {
			installation: { account: { login: 'My-Org-User' } }
		});
		expect(handler.getPrincipal()).toBe('my-org-user');
	});

	it('returns lowercase login of the repository owner when installation account is not set', () => {
		const handler = new TestHandler(baseConfig, {
			repository: { owner: { login: 'Repo-Owner-User' } }
		});
		expect(handler.getPrincipal()).toBe('repo-owner-user');
	});

	it('returns lowercase login of the organization when installation account and repo owner are not set', () => {
		const handler = new TestHandler(baseConfig, {
			organization: { login: 'My-Org' }
		});
		expect(handler.getPrincipal()).toBe('my-org');
	});
});

describe('BaseHandler.isAuthorized', () => {
	it('returns true when ALLOWED_PRINCIPALS is "*"', () => {
		const config = AppConfig.parse({
			GITHUB_CLIENT_ID: 'client-id',
			GITHUB_CLIENT_SECRET: 'client-secret',
			CLOUDFRONT_DOMAIN: 'assets.example.com',
			CLOUDFRONT_PRIVATE_KEY: 'key',
			CLOUDFRONT_KEY_PAIR_ID: 'key-pair-id',
			CLOUDFRONT_SIGNED_COOKIE_EXPIRATION_SECONDS: 900,
			JWT_SECRET: 'jwt-secret',
			JWT_EXPIRATION_SECONDS: 300,
			S3_BUCKET_NAME: 'test-bucket',
			SQS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue',
			ARTIFACT_PATTERNS: 'my-org/my-repo:.github/workflows/ci.yaml:build-output*',
			ALLOWED_PRINCIPALS: '*'
		});
		const handler = new TestHandler(config, {});
		expect(handler.isAuthorized()).toBe(true);
	});

	it('returns false when ALLOWED_PRINCIPALS is configured but principal cannot be determined', () => {
		const config = AppConfig.parse({
			GITHUB_CLIENT_ID: 'client-id',
			GITHUB_CLIENT_SECRET: 'client-secret',
			CLOUDFRONT_DOMAIN: 'assets.example.com',
			CLOUDFRONT_PRIVATE_KEY: 'key',
			CLOUDFRONT_KEY_PAIR_ID: 'key-pair-id',
			CLOUDFRONT_SIGNED_COOKIE_EXPIRATION_SECONDS: 900,
			JWT_SECRET: 'jwt-secret',
			JWT_EXPIRATION_SECONDS: 300,
			S3_BUCKET_NAME: 'test-bucket',
			SQS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue',
			ARTIFACT_PATTERNS: 'my-org/my-repo:.github/workflows/ci.yaml:build-output*',
			ALLOWED_PRINCIPALS: 'org1,org2'
		});
		const handler = new TestHandler(config, {});
		expect(handler.isAuthorized()).toBe(false);
	});

	it('returns true when principal is in ALLOWED_PRINCIPALS (case-insensitively)', () => {
		const config = AppConfig.parse({
			GITHUB_CLIENT_ID: 'client-id',
			GITHUB_CLIENT_SECRET: 'client-secret',
			CLOUDFRONT_DOMAIN: 'assets.example.com',
			CLOUDFRONT_PRIVATE_KEY: 'key',
			CLOUDFRONT_KEY_PAIR_ID: 'key-pair-id',
			CLOUDFRONT_SIGNED_COOKIE_EXPIRATION_SECONDS: 900,
			JWT_SECRET: 'jwt-secret',
			JWT_EXPIRATION_SECONDS: 300,
			S3_BUCKET_NAME: 'test-bucket',
			SQS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue',
			ARTIFACT_PATTERNS: 'my-org/my-repo:.github/workflows/ci.yaml:build-output*',
			ALLOWED_PRINCIPALS: 'ORG1,org2'
		});
		const handler = new TestHandler(config, {
			installation: { account: { login: 'org1' } }
		});
		expect(handler.isAuthorized()).toBe(true);
	});

	it('returns false when principal is not in ALLOWED_PRINCIPALS', () => {
		const config = AppConfig.parse({
			GITHUB_CLIENT_ID: 'client-id',
			GITHUB_CLIENT_SECRET: 'client-secret',
			CLOUDFRONT_DOMAIN: 'assets.example.com',
			CLOUDFRONT_PRIVATE_KEY: 'key',
			CLOUDFRONT_KEY_PAIR_ID: 'key-pair-id',
			CLOUDFRONT_SIGNED_COOKIE_EXPIRATION_SECONDS: 900,
			JWT_SECRET: 'jwt-secret',
			JWT_EXPIRATION_SECONDS: 300,
			S3_BUCKET_NAME: 'test-bucket',
			SQS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue',
			ARTIFACT_PATTERNS: 'my-org/my-repo:.github/workflows/ci.yaml:build-output*',
			ALLOWED_PRINCIPALS: 'org1,org2'
		});
		const handler = new TestHandler(config, {
			installation: { account: { login: 'other-org' } }
		});
		expect(handler.isAuthorized()).toBe(false);
	});
});

describe('BaseHandler.execute', () => {
	it('calls handle when authorized', async () => {
		const config = AppConfig.parse({
			GITHUB_CLIENT_ID: 'client-id',
			GITHUB_CLIENT_SECRET: 'client-secret',
			CLOUDFRONT_DOMAIN: 'assets.example.com',
			CLOUDFRONT_PRIVATE_KEY: 'key',
			CLOUDFRONT_KEY_PAIR_ID: 'key-pair-id',
			CLOUDFRONT_SIGNED_COOKIE_EXPIRATION_SECONDS: 900,
			JWT_SECRET: 'jwt-secret',
			JWT_EXPIRATION_SECONDS: 300,
			S3_BUCKET_NAME: 'test-bucket',
			SQS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue',
			ARTIFACT_PATTERNS: 'my-org/my-repo:.github/workflows/ci.yaml:build-output*',
			ALLOWED_PRINCIPALS: 'org1'
		});
		const handler = new TestHandler(config, {
			installation: { account: { login: 'org1' } }
		});
		await handler.execute();
		expect(handler.handleCalled).toBe(true);
	});

	it('skips handle when unauthorized', async () => {
		const config = AppConfig.parse({
			GITHUB_CLIENT_ID: 'client-id',
			GITHUB_CLIENT_SECRET: 'client-secret',
			CLOUDFRONT_DOMAIN: 'assets.example.com',
			CLOUDFRONT_PRIVATE_KEY: 'key',
			CLOUDFRONT_KEY_PAIR_ID: 'key-pair-id',
			CLOUDFRONT_SIGNED_COOKIE_EXPIRATION_SECONDS: 900,
			JWT_SECRET: 'jwt-secret',
			JWT_EXPIRATION_SECONDS: 300,
			S3_BUCKET_NAME: 'test-bucket',
			SQS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue',
			ARTIFACT_PATTERNS: 'my-org/my-repo:.github/workflows/ci.yaml:build-output*',
			ALLOWED_PRINCIPALS: 'org1'
		});
		const handler = new TestHandler(config, {
			installation: { account: { login: 'unauthorized-org' } }
		});
		await handler.execute();
		expect(handler.handleCalled).toBe(false);
	});
});
