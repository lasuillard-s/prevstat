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
	const probot = createProbot();
	const config = AppConfig.parse(process.env);

	// Extend app locals context
	app.locals.probot = probot;
	app.locals.config = config;

	// Origin access verification middleware
	app.use(function (req, res, next) {
		// If event is coming from AWS internal services, we skip the origin verification.
		// The host header is set by serverless-express so client requests cannot spoof it.
		// See https://github.com/CodeGenieApp/serverless-express#eventsourceroutes
		if (req.path.startsWith('/aws')) {
			if (!req.host.endsWith('.amazonaws.com')) {
				probot.log.warn(
					{ method: req.method, url: req.url, host: req.host },
					'Forbidden request from non-AWS host'
				);
				res.status(403).json({ message: 'Forbidden' });
				return;
			}
			probot.log.debug(
				{ method: req.method, url: req.url, host: req.host },
				'Bypassing origin verification for AWS internal service request'
			);
			next();
			return;
		}

		// Verify origin of requests using a custom header (X-Origin-Verify)
		// to limit access to the Lambda function URL.
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
	app.use(
		await createNodeMiddleware(
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
		)
	);

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
