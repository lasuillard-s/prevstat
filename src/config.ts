import * as z from 'zod';

export const AppConfig = z.object({
	GITHUB_CLIENT_ID: z.string().describe('GitHub OAuth App Client ID'),
	GITHUB_CLIENT_SECRET: z.string().describe('GitHub OAuth App Client Secret'),
	// AWS related configuration
	CLOUDFRONT_DOMAIN: z
		.string()
		.transform((val) => val.replace(/^https?:\/\//, '').replace(/\/+$/, ''))
		.describe('CloudFront domain name for the app (e.g. blabblah.cloudfront.net)'),
	CLOUDFRONT_PRIVATE_KEY: z.string().describe('CloudFront private key for the cookie signing'),
	CLOUDFRONT_KEY_PAIR_ID: z.string().describe('CloudFront key pair ID for the cookie signing'),
	CLOUDFRONT_SIGNED_COOKIE_EXPIRATION_SECONDS: z
		.int()
		.describe('Expiration time for the signed cookie in seconds. Default is 15 minutes.')
		.default(15 * 60), // Default to 15 minutes
	// Lambda origin verification secret to limit access to the Lambda function URL
	ORIGIN_VERIFY_SECRET: z
		.string()
		.optional()
		.describe(
			'Secret for verifying the origin of requests (X-Origin-Verify header). If not set, origin verification is disabled.'
		),
	S3_BUCKET_NAME: z.string().describe('S3 Bucket name for artifact uploads'),
	SQS_QUEUE_URL: z.string().describe('SQS Queue URL for artifact processing'),
	// JWT for GitHub OAuth flow
	JWT_SECRET: z
		.string()
		.describe(
			'Secret for JWT used for signing states in the GitHub OAuth flow. Used to prevent CSRF attacks.'
		),
	JWT_EXPIRATION_SECONDS: z
		.int()
		.describe('Expiration time for the JWT token in seconds. Default is 5 minutes.')
		.default(5 * 60),
	// App configuration
	ARTIFACT_PATTERNS: z
		.string()
		.describe(
			'Comma or newline separated list of artifact glob patterns. Format: owner/repo:workflow_path:artifact (e.g. owner/repo:.github/workflows/ci.yaml:artifact)'
		)
		.transform((val) =>
			val
				.split(/[\r\n,]+/)
				.map((s) => s.trim())
				.filter(Boolean)
		)
});
export type AppConfig = z.infer<typeof AppConfig>;
