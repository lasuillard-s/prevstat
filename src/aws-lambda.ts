import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import serverlessExpress from '@codegenie/serverless-express';
import { createApp } from './app.js';

const s3Client = new S3Client({});

/**
 * Load configuration from an S3 object and merge it into process.env.
 * @param s3Bucket The name of the S3 bucket containing the configuration file.
 * @param s3Key The key (path) to the configuration file within the S3 bucket.
 */
async function initEnv(s3Bucket: string, s3Key: string) {
	try {
		const response = await s3Client.send(new GetObjectCommand({ Bucket: s3Bucket, Key: s3Key }));
		const jsonStr = await response.Body?.transformToString();
		if (jsonStr) {
			const configObj = JSON.parse(jsonStr);
			process.env = { ...process.env, ...configObj };
		} else {
			console.debug('S3 object has no value.');
		}
		console.debug('Successfully retrieved S3 object:', s3Key);
	} catch (error) {
		throw new Error('Error retrieving S3 object', { cause: error });
	}
}

// NOTE: Top-level await in Lambda did not work as expected,
//       so we wrap it in an async IIFE to ensure proper execution order.
const app = await (async function () {
	if (!process.env.LAMBDA_S3_CONFIG_BUCKET || !process.env.LAMBDA_S3_CONFIG_KEY) {
		throw new Error('Missing S3 configuration for Lambda environment.');
	}
	await initEnv(process.env.LAMBDA_S3_CONFIG_BUCKET, process.env.LAMBDA_S3_CONFIG_KEY);
	return createApp();
})();

// https://github.com/CodeGenieApp/serverless-express
// @ts-expect-error Library not properly typed
export const handler = serverlessExpress({
	app,
	eventSourceRoutes: {
		AWS_SQS: '/aws/sqs'
	}
});
