import type { Logger } from 'pino';
import type { ProbotOctokit } from 'probot';
import { Context } from 'probot';
import { AppConfig } from '../config.js';

export const CHECK_RUN_NAME = 'Dev Container Check';

/**
 * Base class for webhook event handlers.
 *
 * Holds the shared event context (octokit, log, repo) and the application
 * configuration, and exposes the contextual utilities that were previously
 * threaded through the config object or duplicated across handlers.
 */
export abstract class BaseHandler<C extends Context = Context> {
	/** The Probot event context for the current webhook delivery. */
	protected readonly context: C;
	/** Validated application configuration. */
	protected readonly appConfig: AppConfig;
	/** Octokit instance bound to the installation that triggered the event. */
	protected readonly octokit: ProbotOctokit;
	/** Logger bound to the event. */
	protected readonly log: Logger;

	constructor(context: C, appConfig: AppConfig) {
		this.context = context;
		this.appConfig = appConfig;
		this.octokit = context.octokit;
		this.log = context.log;
	}

	/**
	 * Handle the webhook event. Implemented by concrete handler subclasses.
	 */
	abstract handle(): Promise<void>;
}
