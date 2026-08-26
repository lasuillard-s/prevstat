import { getCurrentInvoke } from '@codegenie/serverless-express';
import express from 'express';
import { createNodeMiddleware, createProbot, Probot } from 'probot';
import { AppConfig } from './config.js';
import WorkflowRunCompletedHandler from './event-handlers/workflow_run.completed.js';
import { router as apiRouter } from './routes/api/index.js';
import { router as awsRouter } from './routes/aws/index.js';

/**
 * Returns the Express app configured with the Probot middleware and custom routes.
 * @param config Optional application configuration
 * @param probot Optional Probot instance
 * @returns Express app
 */
export async function createApp(config?: AppConfig, probot?: Probot): Promise<express.Express> {
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
		await createNodeMiddleware(setupProbotApp(config), {
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
 * Middleware for verifying request origins.
 * Bypasses origin checks for internal AWS service requests, and checks X-Origin-Verify for other routes.
 * @param req Express request object
 * @param res Express response object
 * @param next Express next function
 */
export function originVerificationMiddleware(
	req: express.Request,
	res: express.Response,
	next: express.NextFunction
): void {
	const probot = req.app.locals.probot as Probot;
	const config = req.app.locals.config as AppConfig;

	/*
	 Internal AWS service routes (/aws/*) are dispatched by serverless-express
	 using event source mapping (e.g. AWS_SQS).

	 To prevent spoofing via public HTTP requests with forged Host headers,
	 verify the true invocation event from the AWS Lambda runtime.

	 See: https://github.com/CodeGenieApp/serverless-express#accessing-the-event-and-context-objects
	*/
	if (req.path.startsWith('/aws')) {
		const { event } = getCurrentInvoke();
		const source = getAwsSource(event);

		if (source === null) {
			probot.log.warn(
				{ method: req.method, url: req.url, host: req.host, source },
				'Forbidden request to internal AWS endpoint'
			);
			res.status(403).json({ message: 'Forbidden' });
			return;
		}

		probot.log.debug(
			{ method: req.method, url: req.url, source },
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
}

/**
 * Detects the AWS event source from a Lambda invocation event.
 * @param event Raw event passed to Lambda handler
 * @returns The detected AWS event source name, or undefined if not recognized
 */
export function getAwsSource(event: unknown): 'aws:sqs' | null {
	if (!event || typeof event !== 'object') {
		return null;
	}

	if ('Records' in event && Array.isArray((event as { Records: unknown[] }).Records)) {
		const records = (event as { Records: Array<{ eventSource?: string }> }).Records;
		if (records.length > 0 && records[0]?.eventSource === 'aws:sqs') {
			return 'aws:sqs';
		}
	}

	return null;
}

/**
 * Creates the Probot app configuration function.
 * @param config Application configuration
 * @returns App initialization function for Probot
 */
export function setupProbotApp(config: AppConfig) {
	return function (probot: Probot): void {
		probot.onError((error) => {
			probot.log.error(error, 'Unhandled error caught');
		});

		// Register event listeners
		// NOTE: Lambda will freeze the process after the handler returns,
		//       so we need to await the handler to ensure it completes before returning.
		probot.on('workflow_run.completed', async (context) => {
			await new WorkflowRunCompletedHandler(context, config).handle();
		});

		probot.log.info('Probot middleware initialized');
	};
}

/**
 * 404 Not Found fallback middleware.
 * @param req Express request object
 * @param res Express response object
 */
export function notFoundMiddleware(req: express.Request, res: express.Response): void {
	const probot = req.app.locals.probot as Probot;
	probot.log.warn({ method: req.method, url: req.url }, 'Route not found');
	res.status(404).json({ message: 'Not Found' });
}
