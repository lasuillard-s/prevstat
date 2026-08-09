import { CloudfrontSignedCookiesOutput, getSignedCookies } from '@aws-sdk/cloudfront-signer';
import { createOAuthUserAuth } from '@octokit/auth-oauth-user';
import { Octokit } from '@octokit/core';
import express, { CookieOptions, Request } from 'express';
import jwt from 'jsonwebtoken';
import { Probot } from 'probot';
import type { AppConfig } from '../config.js';

export const router = express.Router();

/*
Local test-only route for documents served by CloudFront.

This route is unreachable in production, as CloudFront will serve the documents (/private)
directly from S3.
*/
router.get('/private/:owner/:repo/:workflowRunId/:artifactName', (req, res) => {
	return res.status(200).send({ ok: true, url: req.url, params: req.params, query: req.query });
});

router.get(
	'/api/auth',
	(req: Request<object, unknown, unknown, { redirect_uri?: string }>, res) => {
		const probot = req.app.locals.probot as Probot;
		const config = req.app.locals.config as AppConfig;
		const clientId = config.GITHUB_CLIENT_ID;

		const documentUri = req.query.redirect_uri;
		if (!documentUri) {
			return res.status(400).send('Missing redirect URI');
		}

		// Prepare parameters for login redirection
		const proto = req.protocol;
		const host = config.CLOUDFRONT_DOMAIN;
		const redirectUri = new URL('/api/auth/callback', `${proto}://${host}`);
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
	}
);

router.get(
	'/api/auth/callback',
	async (req: Request<object, unknown, unknown, { code: string; state: string }>, res) => {
		const probot = req.app.locals.probot as Probot;
		const config = req.app.locals.config as AppConfig;

		// Validate query parameters
		const code = req.query.code;
		const encryptedState = req.query.state;
		if (!code || !encryptedState) {
			probot.log.error(`Missing code or state in callback: code=${code}, state=${encryptedState}`);
			return res.status(400).send('Missing code or state');
		}

		// Load the request URL from the database for the state (TTL or bad access)
		const state = decryptState(encryptedState, config);
		const documentUri = state.documentUri;
		if (!documentUri) {
			probot.log.error(`Invalid state: ${JSON.stringify(state)}, no original redirect URI found`);
			return res.status(400).send('Invalid state');
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

		// Parse the repository owner and name from the document URI, and validate
		// that the user has read access to it
		const { owner, repo } = parseRepoFromUrl(documentUri);
		if (!owner || !repo) {
			probot.log.error(`Invalid redirect URI: ${documentUri} => ${owner}/${repo}`);
			return res.status(400).send('Invalid redirect URI');
		}
		const { data: repoInfo } = await userOctokit.request('GET /repos/{owner}/{repo}', {
			owner,
			repo
		});

		// Check if use has read access
		if (!repoInfo.permissions?.pull) {
			return res.status(403).send('Have no read access to the repository');
		}

		// Bake CloudFront signed cookies for the user to access the private document
		const validSeconds = config.CLOUDFRONT_SIGNED_COOKIE_EXPIRATION_SECONDS;
		const expiresAt = new Date(Date.now() + validSeconds * 1_000);
		const signedCookies = bakeCloudFrontCookies(`/private/${owner}/${repo}/*`, expiresAt, config);
		const cookieOptions: CookieOptions = {
			path: `/private/${owner}/${repo}/`,
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

/**
 * Parses a repository full name in `owner/repo` format into an object with owner and repo.
 * @param url Repository full name
 * @returns The parsed Repo
 */
function parseRepoFromUrl(url: string): { owner: string; repo: string } {
	// @ts-expect-error Ignore unused variables for now
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const [empty, visibility, owner, repo, workflowRunId, artifactName] = new URL(url).pathname.split(
		'/'
	);
	return { owner, repo };
}

/**
 * Bakes CloudFront signed cookies for access to the temporary website.
 *
 * https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-signed-cookies.html
 * @param path The path to the resource for which the signed cookies are valid. Should be a prefix (e.g., `/private/owner/repo/*`) to allow access to all files in that path.
 * @param expiresAt The expiration date and time for the signed cookies.
 * @param config The application configuration containing CloudFront credentials.
 * @returns Signed CloudFront cookies
 */
function bakeCloudFrontCookies(
	path: string,
	expiresAt: Date,
	config: Readonly<AppConfig>
): CloudfrontSignedCookiesOutput {
	if (path.startsWith('/')) {
		path = path.substring(1);
	}

	const url = `https://${config.CLOUDFRONT_DOMAIN}/${path}`;
	const dateLessThan = Math.floor(expiresAt.getTime() / 1_000);
	const policy = {
		Statement: [
			{
				Resource: url,
				Condition: {
					DateLessThan: {
						'AWS:EpochTime': dateLessThan
					}
				}
			}
		]
	};
	const policyString = JSON.stringify(policy);

	return getSignedCookies({
		keyPairId: config.CLOUDFRONT_KEY_PAIR_ID,
		privateKey: config.CLOUDFRONT_PRIVATE_KEY,
		policy: policyString
	});
}
