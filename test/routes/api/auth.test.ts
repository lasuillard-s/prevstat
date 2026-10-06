import { getSignedCookies } from '@aws-sdk/cloudfront-signer';
import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';
import { AddressInfo } from 'net';
import nock from 'nock';
import type { Probot } from 'probot';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import { AppConfig } from '../../../src/config.js';
import { router as authRouter } from '../../../src/routes/api/auth.js';
import { test as it } from '../../helpers.js';

vi.mock('@aws-sdk/cloudfront-signer', () => ({
	getSignedCookies: vi.fn()
}));

describe('GET /api/auth router', () => {
	let app: express.Express;
	let server: http.Server;
	let serverUrl: string;
	let appConfig: AppConfig;

	beforeEach<{ probot: Probot }>(async ({ probot }) => {
		nock.cleanAll();
		nock.enableNetConnect(/(127\.0\.0\.1|localhost)/);

		appConfig = {
			GITHUB_CLIENT_ID: 'client-id',
			GITHUB_CLIENT_SECRET: 'client-secret',
			ALLOWED_PRINCIPALS: ['*'],
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

		app = express();
		app.use(express.json());
		app.locals.probot = probot;
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

		it('returns 400 when redirect_uri is for an untrusted domain', async () => {
			const response = await fetch(
				`${serverUrl}/api/auth?redirect_uri=${encodeURIComponent('https://evil.com/private/my-org/my-repo/index.html')}`
			);
			expect(response.status).toBe(400);
			expect(await response.text()).toBe('Invalid redirect URI');
		});

		it('returns 400 when redirect_uri is not private', async () => {
			const response = await fetch(
				`${serverUrl}/api/auth?redirect_uri=${encodeURIComponent('https://assets.example.com/public/my-org/my-repo/index.html')}`
			);
			expect(response.status).toBe(400);
			expect(await response.text()).toBe('Invalid redirect URI');
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
			expect(location.searchParams.get('redirect_uri')).toBe(
				'https://assets.example.com/api/auth/callback'
			);

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

			vi.mocked(getSignedCookies).mockReturnValue({
				'CloudFront-Key-Pair-Id': 'key-id',
				'CloudFront-Policy': 'policy',
				'CloudFront-Signature': 'signature'
			});
		});

		it('returns 400 when code is missing', async () => {
			const response = await fetch(`${serverUrl}/api/auth/callback?state=xyz`);
			expect(response.status).toBe(400);
			expect(await response.text()).toBe('Missing code or state');
		});

		it('returns 400 when state is missing', async () => {
			const response = await fetch(`${serverUrl}/api/auth/callback?code=abc`);
			expect(response.status).toBe(400);
			expect(await response.text()).toBe('Missing code or state');
		});

		it('returns 400 on invalid state JWT', async () => {
			const response = await fetch(`${serverUrl}/api/auth/callback?code=abc&state=invalid-jwt`);
			expect(response.status).toBe(400);
			expect(await response.text()).toBe('Invalid or expired state');
		});

		it('returns 400 on expired state JWT', async () => {
			const expiredState = jwt.sign({ documentUri: validDocumentUri }, appConfig.JWT_SECRET, {
				expiresIn: -1
			});
			const response = await fetch(`${serverUrl}/api/auth/callback?code=abc&state=${expiredState}`);
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

		it('returns 400 if documentUri is unparseable', async () => {
			const badUriState = jwt.sign({ documentUri: 'invalid-url' }, appConfig.JWT_SECRET);
			const response = await fetch(`${serverUrl}/api/auth/callback?code=abc&state=${badUriState}`);
			expect(response.status).toBe(400);
			expect(await response.text()).toBe('Invalid state: redirect URI missing or invalid');
		});

		it('returns 400 if documentUri is incomplete for owner/repo', async () => {
			const oauthMock = nock('https://github.com')
				.post('/login/oauth/access_token', {
					client_id: appConfig.GITHUB_CLIENT_ID,
					client_secret: appConfig.GITHUB_CLIENT_SECRET,
					code: 'abc'
				})
				.reply(200, {
					access_token: 'mock-token',
					token_type: 'bearer',
					scope: 'repo'
				});

			const badUriState = jwt.sign(
				{ documentUri: 'https://assets.example.com/private/my-org' },
				appConfig.JWT_SECRET
			);
			const response = await fetch(`${serverUrl}/api/auth/callback?code=abc&state=${badUriState}`);
			expect(response.status).toBe(400);
			expect(await response.text()).toBe('Invalid redirect URI');
			expect(oauthMock.isDone()).toBe(true);
			expect(oauthMock.pendingMocks()).toStrictEqual([]);
		});

		it('returns 403 if user has no read access', async () => {
			const oauthMock = nock('https://github.com')
				.post('/login/oauth/access_token', {
					client_id: appConfig.GITHUB_CLIENT_ID,
					client_secret: appConfig.GITHUB_CLIENT_SECRET,
					code: 'abc'
				})
				.reply(200, {
					access_token: 'mock-token',
					token_type: 'bearer',
					scope: 'repo'
				});

			const apiMock = nock('https://api.github.com')
				.get('/repos/my-org/my-repo')
				.reply(200, { permissions: { pull: false } });

			const response = await fetch(`${serverUrl}/api/auth/callback?code=abc&state=${validState}`);
			expect(response.status).toBe(403);
			expect(await response.text()).toBe('Have no read access to the repository');
			expect(oauthMock.isDone()).toBe(true);
			expect(oauthMock.pendingMocks()).toStrictEqual([]);
			expect(apiMock.isDone()).toBe(true);
			expect(apiMock.pendingMocks()).toStrictEqual([]);
		});

		it('sets cookies and redirects on success', async () => {
			const oauthMock = nock('https://github.com')
				.post('/login/oauth/access_token', {
					client_id: appConfig.GITHUB_CLIENT_ID,
					client_secret: appConfig.GITHUB_CLIENT_SECRET,
					code: 'abc'
				})
				.reply(200, {
					access_token: 'mock-token',
					token_type: 'bearer',
					scope: 'repo'
				});

			const apiMock = nock('https://api.github.com')
				.get('/repos/my-org/my-repo')
				.reply(200, { permissions: { pull: true } });

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
			expect(oauthMock.isDone()).toBe(true);
			expect(oauthMock.pendingMocks()).toStrictEqual([]);
			expect(apiMock.isDone()).toBe(true);
			expect(apiMock.pendingMocks()).toStrictEqual([]);
		});
	});
});
