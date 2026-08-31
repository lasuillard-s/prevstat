import { type CloudfrontSignedCookiesOutput, getSignedCookies } from '@aws-sdk/cloudfront-signer';
import type { AppConfig } from '../../config.js';

/**
 * Bakes CloudFront signed cookies for access to the temporary website.
 *
 * https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-signed-cookies.html
 * @param path The path to the resource for which the signed cookies are valid. Should be a prefix (e.g., `/private/owner/repo/*`) to allow access to all files in that path.
 * @param expiresAt The expiration date and time for the signed cookies.
 * @param config The application configuration containing CloudFront credentials.
 * @returns Signed CloudFront cookies
 */
export function bakeCloudFrontCookies(
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
