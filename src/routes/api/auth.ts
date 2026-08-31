import { createOAuthUserAuth } from '@octokit/auth-oauth-user';
import { Octokit } from '@octokit/core';
import express, { CookieOptions, Request } from 'express';
import jwt from 'jsonwebtoken';
import type { AppConfig } from '../../config.js';
import { bakeCloudFrontCookies } from '../../lib/aws/cloudfront.js';
import { Repo } from '../../lib/github.js';
import { buildRepositoryBasePath, isValidDocumentUri } from '../../lib/url.js';
import { errorToString } from '../../utils/string.js';

export const router = express.Router();

router.get('/', (req: Request<object, unknown, unknown, { redirect_uri?: string }>, res) => {
	const { probot, config } = req.app.locals;
	const clientId = config.GITHUB_CLIENT_ID;

	const documentUri = req.query.redirect_uri;
	if (!documentUri || !isValidDocumentUri(documentUri, config)) {
		probot.log.error(`Invalid redirect URI in authorization request: ${documentUri}`);
		return res.status(400).send('Invalid redirect URI');
	}

	// Prepare parameters for login redirection
	const redirectUri = new URL('/api/auth/callback', `https://${config.CLOUDFRONT_DOMAIN}`);
	const state = encryptState(
		{
			documentUri: documentUri
		},
		config
	);

	// Build the GitHub login URL
	const githubOAuthUrl = new URL('https://github.com/login/oauth/authorize');
	githubOAuthUrl.searchParams.set('client_id', clientId);
	githubOAuthUrl.searchParams.set('redirect_uri', redirectUri.href);
	githubOAuthUrl.searchParams.set('state', state);

	// Redirect to GitHub login
	probot.log.debug(`Redirecting user (${req.ip}) to GitHub login`);
	return res.redirect(githubOAuthUrl.href);
});

router.get(
	'/callback',
	async (req: Request<object, unknown, unknown, { code: string; state: string }>, res) => {
		const { probot, config } = req.app.locals;

		// Validate query parameters
		const code = req.query.code;
		const encryptedState = req.query.state;
		if (!code || !encryptedState) {
			probot.log.error(`Missing code or state in callback: code=${code}, state=${encryptedState}`);
			return res.status(400).send('Missing code or state');
		}

		// Decrypt the state token
		let state: State;
		try {
			state = decryptState(encryptedState, config);
		} catch (error) {
			probot.log.error(`Failed to decrypt state in callback: ${errorToString(error)}`);
			return res.status(400).send('Invalid or expired state');
		}

		const documentUri = state.documentUri;
		if (!documentUri || !isValidDocumentUri(documentUri, config)) {
			probot.log.error(`Invalid state: no valid redirect URI found in state (${documentUri})`);
			return res.status(400).send('Invalid state: redirect URI missing or invalid');
		}

		// Exchange the code for an access token using GitHub OAuth
		const clientId = config.GITHUB_CLIENT_ID;
		const clientSecret = config.GITHUB_CLIENT_SECRET;
		const auth = createOAuthUserAuth({
			clientId,
			clientSecret,
			code
		});
		const { token } = await auth();
		const userOctokit = new Octokit({ auth: token });

		// Parse the repository owner and name from the document URI
		let repo: Repo;
		try {
			repo = Repo.fromUrl(documentUri);
		} catch (error) {
			probot.log.error(`Invalid redirect URI: ${documentUri} => ${errorToString(error)}`);
			return res.status(400).send('Invalid redirect URI');
		}

		// Fetch repository information to check permissions
		const { data: repoInfo } = await userOctokit.request('GET /repos/{owner}/{repo}', {
			owner: repo.owner,
			repo: repo.repo
		});

		// Check if use has read access
		if (!repoInfo.permissions?.pull) {
			return res.status(403).send('Have no read access to the repository');
		}

		// Bake CloudFront signed cookies for the user to access the private document
		const validSeconds = config.CLOUDFRONT_SIGNED_COOKIE_EXPIRATION_SECONDS;
		const expiresAt = new Date(Date.now() + validSeconds * 1_000);
		const basePath = buildRepositoryBasePath('private', repo.owner, repo.repo);
		const signedCookies = bakeCloudFrontCookies(`${basePath}/*`, expiresAt, config);
		const cookieOptions: CookieOptions = {
			path: `${basePath}/`,
			httpOnly: true,
			secure: true,
			sameSite: 'lax',
			expires: expiresAt
		};

		return res
			.cookie('CloudFront-Key-Pair-Id', signedCookies['CloudFront-Key-Pair-Id'], cookieOptions)
			.cookie('CloudFront-Policy', signedCookies['CloudFront-Policy'], cookieOptions)
			.cookie('CloudFront-Signature', signedCookies['CloudFront-Signature'], cookieOptions)
			.redirect(documentUri);
	}
);

interface State {
	documentUri: string;
}

/**
 * Encrypts the state object into a Base64 string for stateless retrieval after GitHub OAuth callback.
 * @param state The state object to encrypt.
 * @param config The application configuration containing the JWT secret and expiration.
 * @returns The encrypted JWT token as a string.
 */
function encryptState(state: State, config: Readonly<AppConfig>): string {
	return jwt.sign(state, config.JWT_SECRET, { expiresIn: config.JWT_EXPIRATION_SECONDS });
}

/**
 * Decrypts the JWT token back into a state object.
 * @param encryptedState The JWT token to decrypt.
 * @param config The application configuration containing the JWT secret.
 * @returns The decrypted state object.
 */
function decryptState(encryptedState: string, config: Readonly<AppConfig>): State {
	return jwt.verify(encryptedState, config.JWT_SECRET) as State;
}
