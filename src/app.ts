import express from 'express';
import { ApplicationFunction, createNodeMiddleware, createProbot } from 'probot';
import { router as authRouter } from './api/auth.js';
import { AppConfig, loadConfig } from './config.js';
import WorkflowRunCompletedHandler from './handlers/workflow_run.completed.js';
import { errorToString } from './utils.js';

/**
 * Returns the Express app configured with the Probot middleware and custom routes.
 * @returns Express app
 */
export async function createApp(): Promise<express.Express> {
	const app = express();

	// Probot webhook middleware
	const probot = createProbot();
	const probotMiddleware = await createNodeMiddleware(appFn, {
		probot,
		webhooksPath: '/api/github/webhooks'
	});

	// Load and validate configuration
	const config: AppConfig = loadConfig(probot);

	// Make probot available to all routes
	app.locals.probot = probot;
	app.locals.config = config;

	// Register middlewares
	app.use(probotMiddleware);
	app.use(express.json());

	// Register routes
	app.use('/', authRouter);

	// Register event listeners
	// NOTE: Handlers are not awaited here because they are expected to handle events asynchronously,
	//       notifying GitHub of the event receipt (10s timeout) while processing the event in the background.
	probot.on('workflow_run.completed', async (context) => {
		new WorkflowRunCompletedHandler(context, config).handle().catch((error) => {
			context.log.error(`Error handling workflow_run.completed event: ${errorToString(error)}`);
		});
	});

	return app;
}

// Probot app entrypoint
const appFn: ApplicationFunction = (app) => {
	app.log.info('Presta app is running');
};
