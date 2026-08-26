import { getSignedCookies } from '@aws-sdk/cloudfront-signer';
import { createOAuthUserAuth } from '@octokit/auth-oauth-user';
import { Octokit } from '@octokit/core';
import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';
import { AddressInfo } from 'net';
import nock from 'nock';
import { Probot } from 'probot';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppConfig } from '../../../src/config.js';
import {
	router as authRouter,
	isValidDocumentUri,
	parseRepoFromUrl
} from '../../../src/routes/api/auth.js';

vi.mock('@octokit/auth-oauth-user', () => ({
	createOAuthUserAuth: vi.fn()
}));

vi.mock('@octokit/core', () => {
	const OctokitMock = vi.fn();
	OctokitMock.prototype.request = vi.fn();
	return { Octokit: OctokitMock };
});

vi.mock('@aws-sdk/cloudfront-signer', () => ({
	getSignedCookies: vi.fn()
}));

describe('GET /api/auth router', () => {
	let app: express.Express;
	let server: http.Server;
	let serverUrl: string;
	let appConfig: AppConfig;
	let mockProbot: Probot;

	beforeEach(async () => {
		nock.enableNetConnect(/(127\.0\.0\.1|localhost)/);

		appConfig = {
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
			}
		} as unknown as Probot;

		app = express();
		app.use(express.json());
		app.locals.probot = mockProbot;
		app.locals.config = appConfig;
		app.use('/api/auth', authRouter);

		server = http.createServer(app);
		await new Promise<void>((resolve) => {
			server.listen(0, () => {
				const port = (server.address() as AddressInfo).port;
				serverUrl = `http://127.0.0.1:${port}`;
				resolve();
			});
		});

		vi.clearAllMocks();
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
	});

	describe('GET /', () => {
		it('returns 400 when redirect_uri is missing', async () => {
			const response = await fetch(`${serverUrl}/api/auth`);
			expect(response.status).toBe(400);
			expect(await response.text()).toBe('Invalid redirect URI');
		});

		it('returns 400 when redirect_uri is for an untrusted domain or not private', async () => {
			const response1 = await fetch(
				`${serverUrl}/api/auth?redirect_uri=${encodeURIComponent('https://evil.com/private/my-org/my-repo/index.html')}`
			);
			expect(response1.status).toBe(400);
			expect(await response1.text()).toBe('Invalid redirect URI');

			const response2 = await fetch(
				`${serverUrl}/api/auth?redirect_uri=${encodeURIComponent('https://assets.example.com/public/my-org/my-repo/index.html')}`
			);
			expect(response2.status).toBe(400);
			expect(await response2.text()).toBe('Invalid redirect URI');
		});

		it('redirects to GitHub login with correct parameters', async () => {
			const redirectUri = encodeURIComponent(
				'https://assets.example.com/private/my-org/my-repo/index.html'
			);
			const response = await fetch(`${serverUrl}/api/auth?redirect_uri=${redirectUri}`, {
				redirect: 'manual'
			});

			expect(response.status).toBe(302);
			const location = new URL(response.headers.get('location')!);
			expect(location.origin).toBe('https://github.com');
			expect(location.pathname).toBe('/login/oauth/authorize');
			expect(location.searchParams.get('client_id')).toBe(appConfig.GITHUB_CLIENT_ID);
			expect(location.searchParams.get('redirect_uri')).toMatch(/^http.*\/api\/auth\/callback$/);

			const state = location.searchParams.get('state');
			expect(state).toBeTruthy();

			// Verify state is a valid JWT
			const decoded = jwt.verify(state!, appConfig.JWT_SECRET) as jwt.JwtPayload;
			expect(decoded.documentUri).toBe(
				'https://assets.example.com/private/my-org/my-repo/index.html'
			);
		});
	});

	describe('GET /callback', () => {
		const validDocumentUri =
			'https://assets.example.com/private/my-org/my-repo/123/build-output/index.html';
		let validState: string;

		beforeEach(() => {
			validState = jwt.sign({ documentUri: validDocumentUri }, appConfig.JWT_SECRET);

			vi.mocked(createOAuthUserAuth).mockReturnValue((async () => ({
				token: 'mock-token',
				authentication: {} as never
			})) as never);

			vi.mocked(getSignedCookies).mockReturnValue({
				'CloudFront-Key-Pair-Id': 'key-id',
				'CloudFront-Policy': 'policy',
				'CloudFront-Signature': 'signature'
			});
		});

		it('returns 400 when code or state is missing', async () => {
			const response1 = await fetch(`${serverUrl}/api/auth/callback?code=abc`);
			expect(response1.status).toBe(400);
			expect(await response1.text()).toBe('Missing code or state');

			const response2 = await fetch(`${serverUrl}/api/auth/callback?state=xyz`);
			expect(response2.status).toBe(400);
			expect(await response2.text()).toBe('Missing code or state');
		});

		it('returns 400 on invalid or expired state JWT', async () => {
			const response = await fetch(`${serverUrl}/api/auth/callback?code=abc&state=invalid-jwt`);
			expect(response.status).toBe(400);
			expect(await response.text()).toBe('Invalid or expired state');
		});

		it('returns 400 if state has no documentUri', async () => {
			const badState = jwt.sign({}, appConfig.JWT_SECRET);
			const response = await fetch(`${serverUrl}/api/auth/callback?code=abc&state=${badState}`);
			expect(response.status).toBe(400);
			expect(await response.text()).toBe('Invalid state: redirect URI missing or invalid');
		});

		it('returns 400 if documentUri targets an untrusted domain (open redirect attempt)', async () => {
			const evilState = jwt.sign(
				{ documentUri: 'https://evil.com/private/my-org/my-repo/123/build-output/index.html' },
				appConfig.JWT_SECRET
			);
			const response = await fetch(`${serverUrl}/api/auth/callback?code=abc&state=${evilState}`);
			expect(response.status).toBe(400);
			expect(await response.text()).toBe('Invalid state: redirect URI missing or invalid');
		});

		it('returns 400 if documentUri is unparseable or incomplete for owner/repo', async () => {
			const badUriState = jwt.sign(
				{ documentUri: 'https://assets.example.com/private/my-org' },
				appConfig.JWT_SECRET
			);
			const response = await fetch(`${serverUrl}/api/auth/callback?code=abc&state=${badUriState}`);
			expect(response.status).toBe(400);
			expect(await response.text()).toBe('Invalid redirect URI');
		});

		it('returns 403 if user has no read access', async () => {
			const mockRequest = vi.fn().mockResolvedValue({
				data: { permissions: { pull: false } }
			});
			Octokit.prototype.request = mockRequest as never;

			const response = await fetch(`${serverUrl}/api/auth/callback?code=abc&state=${validState}`);
			expect(response.status).toBe(403);
			expect(await response.text()).toBe('Have no read access to the repository');

			expect(mockRequest).toHaveBeenCalledWith('GET /repos/{owner}/{repo}', {
				owner: 'my-org',
				repo: 'my-repo'
			});
		});

		it('sets cookies and redirects on success', async () => {
			const mockRequest = vi.fn().mockResolvedValue({
				data: { permissions: { pull: true } }
			});
			Octokit.prototype.request = mockRequest as never;

			const response = await fetch(`${serverUrl}/api/auth/callback?code=abc&state=${validState}`, {
				redirect: 'manual'
			});

			expect(response.status).toBe(302);
			expect(response.headers.get('location')).toBe(validDocumentUri);

			const cookies = response.headers.get('set-cookie');
			expect(cookies).toContain('CloudFront-Key-Pair-Id=key-id');
			expect(cookies).toContain('CloudFront-Policy=policy');
			expect(cookies).toContain('CloudFront-Signature=signature');
			expect(cookies).toContain('Secure');
			expect(cookies).toContain('HttpOnly');

			expect(getSignedCookies).toHaveBeenCalledWith({
				keyPairId: 'key-pair-id',
				privateKey: 'key',
				policy: expect.any(String)
			});
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
			expect(() =>
				parseRepoFromUrl('https://assets.example.com/private/my-org/my-repo/123')
			).toThrow('Incomplete artifact path in URL');

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
		it('returns true for valid CloudFront private document URIs', () => {
			expect(
				isValidDocumentUri(
					'https://assets.example.com/private/my-org/my-repo/123/build-output/index.html',
					appConfig
				)
			).toBe(true);
		});

		it('returns false for foreign domains', () => {
			expect(
				isValidDocumentUri(
					'https://attacker.com/private/my-org/my-repo/123/build-output/index.html',
					appConfig
				)
			).toBe(false);
		});

		it('returns false for non-private paths', () => {
			expect(
				isValidDocumentUri(
					'https://assets.example.com/public/my-org/my-repo/123/build-output/index.html',
					appConfig
				)
			).toBe(false);
			expect(isValidDocumentUri('https://assets.example.com/api/auth', appConfig)).toBe(false);
		});

		it('returns false for malformed URLs', () => {
			expect(isValidDocumentUri('not-a-url', appConfig)).toBe(false);
		});
	});
});
