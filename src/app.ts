import express from 'express';
import { ApplicationFunction, createNodeMiddleware, createProbot } from 'probot';
import { router as authRouter } from './api/auth.js';
import { AppConfig, loadConfig } from './config.js';

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

	return app;
}

// Probot app entrypoint
const appFn: ApplicationFunction = (app) => {
	app.log.info('Presta app is running');
};
