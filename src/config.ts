import type { Probot } from 'probot';
import * as z from 'zod';
import { errorToString } from './utils.js';

export const AppConfig = z.object({
	EXAMPLE: z.string().default('default')
});
export type AppConfig = z.infer<typeof AppConfig>;

/**
 * Load app configuration from environment variables.
 * @param app Current Probot app instance
 * @returns Validated application configuration
 */
export function loadConfig(app: Probot): AppConfig {
	try {
		return AppConfig.parse(process.env);
	} catch (error) {
		app.log.error(`Failed to load configuration: ${errorToString(error)}`);
		process.exit(1);
	}
}
