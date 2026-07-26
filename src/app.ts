import Express from 'express';
import { ApplicationFunction, createNodeMiddleware, createProbot } from 'probot';

// Probot app entrypoint
const appFn: ApplicationFunction = (app) => {
	app.log.info('Presta is running');
};

/**
 * Returns the Express app configured with the Probot middleware and custom routes.
 * @returns Express app
 */
export async function getApp() {
	const express = Express();

	// Probot webhook middleware
	const probot = createProbot();
	const middleware = await createNodeMiddleware(appFn, {
		probot,
		webhooksPath: '/api/github/webhooks'
	});

	// Make probot available to all routes
	express.locals.probot = probot;

	// Register middlewares
	express.use(middleware);
	express.use(Express.json());

	// Route for temporarily hosted websites
	express.get('/:owner/:repo/:sha/:workflow/:artifact', (req, res) => {
		const { probot } = req.app.locals;
		probot.log.info('Presta is serving a temporary website for:', req.params);
		res.send({ ok: true });
	});

	return express;
}
