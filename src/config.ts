import type { Probot } from 'probot';
import * as z from 'zod';
import { errorToString } from './utils.js';

export const AppConfig = z.object({
	GITHUB_CLIENT_ID: z.string().describe('GitHub OAuth App Client ID'),
	GITHUB_CLIENT_SECRET: z.string().describe('GitHub OAuth App Client Secret'),
	CLOUDFRONT_DOMAIN: z
		.string()
		.describe('CloudFront domain name for the app (e.g. https://blabblah.cloudfront.net)'),
	CLOUDFRONT_PRIVATE_KEY: z.string().describe('CloudFront private key for the cookie signing'),
	CLOUDFRONT_KEY_PAIR_ID: z.string().describe('CloudFront key pair ID for the cookie signing'),
	CLOUDFRONT_SIGNED_COOKIE_EXPIRATION_SECONDS: z
		.int()
		.describe('Expiration time for the signed cookie in seconds. Default is 15 minutes.')
		.default(15 * 60), // Default to 15 minutes
	JWT_SECRET: z.string().describe('Secret for signing JWT tokens'),
	JWT_EXPIRATION_SECONDS: z
		.int()
		.describe('Expiration time for the JWT token in seconds. Default is 5 minutes.')
		.default(5 * 60), // Default to 5 minutes
	S3_BUCKET_NAME: z.string().describe('S3 Bucket name for artifact uploads'),
	ARTIFACT_PATTERNS: z
		.string()
		.describe(
			'Comma separated list of artifact glob patterns. Format: owner/repo:workflow:artifact'
		)
		.transform((val) => val.split(',').map((s) => s.trim()))
});
export type AppConfig = z.infer<typeof AppConfig>;

/**
 * Load app configuration from environment variables.
 * @param app Current Probot app instance
 * @returns Validated application configuration
 */
export function loadConfig(app: Probot): AppConfig {
	try {
		return AppConfig.parse(process.env);
	} catch (error) {
		app.log.error(`Failed to load configuration: ${errorToString(error)}`);
		process.exit(1);
	}
}
