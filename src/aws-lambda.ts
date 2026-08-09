import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import serverlessExpress from '@codegenie/serverless-express';
import { createApp } from './app.js';

/**
 * Load SSM parameter (process.env.LAMBDA_SSM_PARAMETER_NAME) and merge it into process.env.
 * @param ssmParameterName The name or ARN of the SSM parameter to retrieve.
 */
async function initEnv(ssmParameterName?: string) {
	try {
		const client = new SSMClient();
		const command = new GetParameterCommand({ Name: ssmParameterName, WithDecryption: true });
		const response = await client.send(command);
		if (response.Parameter?.Value) {
			const configObj = JSON.parse(response.Parameter.Value);
			process.env = { ...process.env, ...configObj };
		} else {
			console.debug('SSM parameter has no value.');
		}
		console.debug('Successfully retrieved SSM parameter:', ssmParameterName);
	} catch (error) {
		console.error('Error retrieving SSM parameter:', error);
		process.exit(1); // Exit the process with a non-zero status code to indicate failure
	}
}

// NOTE: SSM parameter retrieval using top-level await in Lambda did not work as expected,
//       so we wrap it in an async IIFE to ensure proper execution order.
const app = await (async function () {
	await initEnv(process.env.LAMBDA_SSM_PARAMETER_NAME);
	return createApp();
})();

// @ts-expect-error Library not properly typed
export const handler = serverlessExpress({ app });
