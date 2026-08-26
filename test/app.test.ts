import { beforeEach, describe, expect, vi } from 'vitest';
import { createApp, setupProbotApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { test as it } from './helpers.js';

vi.mock('../src/event-handlers/workflow_run.completed.js', () => {
	return {
		default: class {
			handle = vi.fn().mockResolvedValue(undefined);
		}
	};
});

describe('createApp', () => {
	let mockConfig: AppConfig;

	beforeEach(() => {
		mockConfig = {
			ORIGIN_VERIFY_SECRET: 'test-secret',
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
			ARTIFACT_PATTERNS: ['my-org/my-repo:.github/workflows/ci.yaml:build-output*']
		};
	});

	it('configures Express app with locals, routes, and middleware', async ({ probot }) => {
		const app = await createApp(mockConfig, probot);
		expect(app).toBeDefined();
		expect(app.locals.probot).toBe(probot);
		expect(app.locals.config).toBe(mockConfig);
	});
});

describe('setupProbotApp', () => {
	let mockConfig: AppConfig;

	beforeEach(() => {
		mockConfig = {
			ORIGIN_VERIFY_SECRET: 'test-secret',
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
			ARTIFACT_PATTERNS: ['my-org/my-repo:.github/workflows/ci.yaml:build-output*']
		};
	});

	it('registers error and workflow_run listeners', async ({ probot }) => {
		const probotApp = setupProbotApp(mockConfig);
		const onErrorSpy = vi.spyOn(probot, 'onError');
		const onSpy = vi.spyOn(probot, 'on');

		probotApp(probot);

		expect(onErrorSpy).toHaveBeenCalled();
		expect(onSpy).toHaveBeenCalledWith('workflow_run.completed', expect.any(Function));

		// Execute error callback
		const errorCb = onErrorSpy.mock.calls[0][0];
		expect(() => errorCb(new Error('test error') as never)).not.toThrow();

		// Execute event callback
		const eventCb = onSpy.mock.calls[0][1];
		await expect(
			eventCb({ name: 'workflow_run.completed', payload: {} } as never)
		).resolves.not.toThrow();
	});
});
