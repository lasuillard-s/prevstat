import type { SQSClient } from '@aws-sdk/client-sqs';
import express from 'express';
import { createNodeMiddleware, createProbot, Probot } from 'probot';
import { AppConfig } from './config.js';
import WorkflowRunCompletedHandler from './event-handlers/workflow_run.completed.js';
import { notFoundMiddleware, originVerificationMiddleware } from './middlewares.js';
import { router as apiRouter } from './routes/api/index.js';
import { router as awsRouter } from './routes/aws/index.js';

/**
 * Returns the Express app configured with the Probot middleware and custom routes.
 * @param config Optional application configuration
 * @param probot Optional Probot instance
 * @param setupProbot Optional Probot application setup function
 * @returns Express app
 */
export async function createApp(
	config?: AppConfig,
	probot?: Probot,
	setupProbot?: (probot: Probot) => void | Promise<void>
): Promise<express.Express> {
	const app = express();
	probot ??= createProbot();
	if (!config) {
		try {
			config = AppConfig.parse(process.env);
		} catch (error) {
			probot.log.error(`Failed to load configuration: ${error}`);
			process.exit(1);
		}
	}

	// Extend app locals context
	app.locals.probot = probot;
	app.locals.config = config;

	// Middleware
	app.use(originVerificationMiddleware);
	app.use(
		await createNodeMiddleware(setupProbot ?? setupProbotApp(config, app.locals.sqsClient), {
			probot,
			webhooksPath: '/api/github/webhooks'
		})
	);

	// Register routes
	app.use('/api', apiRouter);
	app.use('/aws', awsRouter);

	// Fallback
	app.use(notFoundMiddleware);

	return app;
}

/**
 * Creates the Probot app configuration function.
 * @param config Application configuration
 * @param sqsClient Optional SQS client instance
 * @returns App initialization function for Probot
 */
export function setupProbotApp(config: AppConfig, sqsClient?: SQSClient) {
	return function (probot: Probot): void {
		probot.onError((error) => {
			probot.log.error(error, 'Unhandled error caught');
		});

		// Register event listeners
		// NOTE: Lambda will freeze the process after the handler returns,
		//       so we need to await the handler to ensure it completes before returning.
		probot.on('workflow_run.completed', async (context) => {
			await new WorkflowRunCompletedHandler(context, config, sqsClient).handle();
		});

		probot.log.info('Probot middleware initialized');
	};
}
