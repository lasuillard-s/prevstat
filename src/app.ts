import express from 'express';
import { createNodeMiddleware, createProbot } from 'probot';
import { AppConfig } from './config.js';
import WorkflowRunCompletedHandler from './handlers/workflow_run.completed.js';
import { router as apiRouter } from './routes/api/index.js';
import { router as awsRouter } from './routes/aws/index.js';

/**
 * Returns the Express app configured with the Probot middleware and custom routes.
 * @returns Express app
 */
export async function createApp(): Promise<express.Express> {
	const app = express();
	const config = AppConfig.parse(process.env);

	// Probot webhook middleware
	const probot = createProbot();
	const probotMiddleware = await createNodeMiddleware(
		function (probot) {
			probot.log.info('Probot middleware initialized');

			// Register event listeners
			// NOTE: Handlers are not awaited here because they are expected to handle events asynchronously,
			//       notifying GitHub of the event receipt (10s timeout) while processing the event in the background.
			probot.onError((error) => {
				probot.log.error(error, 'Unhandled error caught');
			});
			probot.on('workflow_run.completed', async (context) => {
				await new WorkflowRunCompletedHandler(context, config).handle();
			});
		},
		{
			probot,
			webhooksPath: '/api/github/webhooks'
		}
	);

	// Make probot available to all routes
	app.locals.probot = probot;
	app.locals.config = config;

	// Register middlewares

	// Verify origin of requests using a custom header (X-Origin-Verify)
	// to limit access to the Lambda function URL.
	app.use(function (req, res, next) {
		const clientSecret = req.header('X-Origin-Verify');
		const expected = config.ORIGIN_VERIFY_SECRET;
		if (expected && clientSecret !== expected) {
			probot.log.warn({ method: req.method, url: req.url }, 'Unauthorized request');
			res.status(401).json({ message: 'Unauthorized' });
			return;
		}
		next();
	});

	// Probot middleware for handling GitHub webhooks
	app.use(probotMiddleware);

	// Register routes
	app.use('/api', apiRouter);
	app.use('/aws', awsRouter);

	// Fallback
	app.use(function (req, res) {
		probot.log.warn({ method: req.method, url: req.url }, 'Route not found');
		res.status(404).json({ message: 'Not Found' });
	});

	return app;
}
