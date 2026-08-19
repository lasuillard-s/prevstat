import type express from 'express';
import type { Probot } from 'probot';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createApp,
	notFoundMiddleware,
	originVerificationMiddleware,
	setupProbotApp
} from '../src/app.js';
import type { AppConfig } from '../src/config.js';

vi.mock('../src/event-handlers/workflow_run.completed.js', () => {
	return {
		default: class {
			handle = vi.fn().mockResolvedValue(undefined);
		}
	};
});

describe('app.ts', () => {
	let mockProbot: Probot;
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

		mockProbot = {
			log: {
				debug: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn()
			},
			onError: vi.fn(),
			on: vi.fn(),
			load: vi.fn().mockImplementation(async (fn) => {
				await fn(mockProbot);
			}),
			getNodeMiddleware: vi
				.fn()
				.mockResolvedValue((req: unknown, res: unknown, next?: () => void) =>
					next ? next() : false
				)
		} as unknown as Probot;
	});

	describe('createApp', () => {
		it('configures Express app with locals, routes, and middleware', async () => {
			const app = await createApp(mockConfig, mockProbot);
			expect(app).toBeDefined();
			expect(app.locals.probot).toBe(mockProbot);
			expect(app.locals.config).toBe(mockConfig);
		});
	});

	describe('originVerificationMiddleware', () => {
		const createMockReqRes = (path: string, host: string, originVerifyHeader?: string) => {
			const req = {
				path,
				host,
				header: vi.fn((headerName: string) => {
					if (headerName.toLowerCase() === 'x-origin-verify') return originVerifyHeader;
					return undefined;
				}),
				app: {
					locals: {
						probot: mockProbot,
						config: mockConfig
					}
				}
			} as unknown as express.Request;

			const res = {
				status: vi.fn().mockReturnThis(),
				json: vi.fn().mockReturnThis()
			} as unknown as express.Response;

			const next = vi.fn() as express.NextFunction;

			return { req, res, next };
		};

		it('allows AWS internal requests if host is .amazonaws.com', () => {
			const { req, res, next } = createMockReqRes('/aws/sqs', 'lambda.amazonaws.com');
			originVerificationMiddleware(req, res, next);
			expect(next).toHaveBeenCalled();
			expect(res.status).not.toHaveBeenCalled();
		});

		it('rejects /aws requests from non-AWS hosts', () => {
			const { req, res, next } = createMockReqRes('/aws/sqs', 'example.com');
			originVerificationMiddleware(req, res, next);
			expect(res.status).toHaveBeenCalledWith(403);
			expect(res.json).toHaveBeenCalledWith({ message: 'Forbidden' });
			expect(next).not.toHaveBeenCalled();
		});

		it('rejects non-AWS requests if X-Origin-Verify does not match', () => {
			const { req, res, next } = createMockReqRes('/api/auth', 'example.com', 'wrong-secret');
			originVerificationMiddleware(req, res, next);
			expect(res.status).toHaveBeenCalledWith(401);
			expect(res.json).toHaveBeenCalledWith({ message: 'Unauthorized' });
			expect(next).not.toHaveBeenCalled();
		});

		it('allows non-AWS requests if X-Origin-Verify matches', () => {
			const { req, res, next } = createMockReqRes('/api/auth', 'example.com', 'test-secret');
			originVerificationMiddleware(req, res, next);
			expect(next).toHaveBeenCalled();
			expect(res.status).not.toHaveBeenCalled();
		});

		it('allows requests if ORIGIN_VERIFY_SECRET is not set', () => {
			mockConfig.ORIGIN_VERIFY_SECRET = undefined;
			const { req, res, next } = createMockReqRes('/api/auth', 'example.com');
			originVerificationMiddleware(req, res, next);
			expect(next).toHaveBeenCalled();
			expect(res.status).not.toHaveBeenCalled();
		});
	});

	describe('setupProbotApp', () => {
		it('registers error and workflow_run listeners', async () => {
			const probotApp = setupProbotApp(mockConfig);
			const onErrorMock = vi.fn();
			const onMock = vi.fn();
			const testProbot = {
				log: { info: vi.fn(), error: vi.fn() },
				onError: onErrorMock,
				on: onMock
			} as unknown as Probot;

			probotApp(testProbot);

			expect(testProbot.log.info).toHaveBeenCalledWith('Probot middleware initialized');
			expect(onErrorMock).toHaveBeenCalled();
			expect(onMock).toHaveBeenCalledWith('workflow_run.completed', expect.any(Function));

			// Execute error callback
			const errorCb = onErrorMock.mock.calls[0][0];
			errorCb(new Error('test error'));
			expect(testProbot.log.error).toHaveBeenCalled();

			// Execute event callback
			const eventCb = onMock.mock.calls[0][1];
			await eventCb({ name: 'workflow_run.completed', payload: {} });
		});
	});

	describe('notFoundMiddleware', () => {
		it('returns 404 Not Found', () => {
			const req = {
				method: 'GET',
				url: '/unknown',
				app: { locals: { probot: mockProbot } }
			} as unknown as express.Request;

			const res = {
				status: vi.fn().mockReturnThis(),
				json: vi.fn().mockReturnThis()
			} as unknown as express.Response;

			notFoundMiddleware(req, res);
			expect(res.status).toHaveBeenCalledWith(404);
			expect(res.json).toHaveBeenCalledWith({ message: 'Not Found' });
		});
	});
});
