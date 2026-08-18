import express from 'express';
import { ApplicationFunction, createNodeMiddleware, createProbot } from 'probot';
import { AppConfig, loadConfig } from './config.js';
import WorkflowRunCompletedHandler from './handlers/workflow_run.completed.js';
import { router as apiRouter } from './routes/api/index.js';
import { router as awsRouter } from './routes/aws/index.js';

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
	app.use('/api', apiRouter);
	app.use('/aws', awsRouter);

	// Register event listeners
	// NOTE: Handlers are not awaited here because they are expected to handle events asynchronously,
	//       notifying GitHub of the event receipt (10s timeout) while processing the event in the background.
	probot.onError((error) => {
		probot.log.error(error, 'Unhandled error caught');
	});
	probot.on('workflow_run.completed', async (context) => {
		await new WorkflowRunCompletedHandler(context, config).handle();
	});

	return app;
}

// Probot app entrypoint
const appFn: ApplicationFunction = (app) => {
	app.log.info('Presta app is running');
};
