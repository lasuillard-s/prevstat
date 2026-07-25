import { createLambdaFunction, createProbot } from '@probot/adapter-aws-lambda-serverless';
import appFn from './app.js';

// @ts-expect-error Third-party library type issue, ignore for now
export const handler = createLambdaFunction(appFn, {
	probot: createProbot()
});
