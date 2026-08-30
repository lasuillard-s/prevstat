import { getCurrentInvoke } from '@codegenie/serverless-express';
import express from 'express';
import type { Probot } from 'probot';
import type { AppConfig } from './config.js';

/**
 * Detects the AWS event source from a Lambda invocation event.
 * @param event Raw event passed to Lambda handler
 * @returns The detected AWS event source name, or null if not recognized
 */
export function getAwsSource(event: unknown): 'aws:sqs' | null {
	if (!event || typeof event !== 'object') {
		return null;
	}

	if ('Records' in event && Array.isArray((event as { Records: unknown[] }).Records)) {
		const records = (event as { Records: Array<{ eventSource?: string }> }).Records;
		if (records.some((record) => record?.eventSource === 'aws:sqs')) {
			return 'aws:sqs';
		}
	}

	return null;
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
 * 404 Not Found fallback middleware.
 * @param req Express request object
 * @param res Express response object
 */
export function notFoundMiddleware(req: express.Request, res: express.Response): void {
	const probot = req.app.locals.probot as Probot;
	probot.log.warn({ method: req.method, url: req.url }, 'Route not found');
	res.status(404).json({ message: 'Not Found' });
}
