import type { Logger } from 'pino';
import type { ProbotOctokit } from 'probot';
import { Context } from 'probot';
import { AppConfig } from '../config.js';
import { Repo } from '../lib/github.js';

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

	/**
	 * Executes the handler after verifying that the event originated from an authorized principal.
	 * If unauthorized, the event is skipped.
	 */
	public async execute(): Promise<void> {
		if (!this.isAuthorized()) {
			this.log.warn(
				`Skipping event processing for unauthorized principal: "${this.getPrincipal() ?? 'unknown'}"`
			);
			return;
		}
		await this.handle();
	}

	/**
	 * Checks if the current installation principal is authorized under ALLOWED_PRINCIPALS.
	 * @returns true if authorized or if allowlist is unrestricted ('*')
	 */
	public isAuthorized(): boolean {
		const allowedPrincipals = this.appConfig.ALLOWED_PRINCIPALS;
		if (allowedPrincipals.includes('*')) {
			return true;
		}

		const principal = this.getPrincipal();
		if (!principal) {
			return false;
		}

		return allowedPrincipals.includes(principal);
	}

	/**
	 * Retrieves the principal (login) of the installation account, repository owner, or organization from the context payload.
	 * @returns The lowercase principal login or null if not available.
	 */
	public getPrincipal(): string | null {
		const payload = this.context.payload as {
			installation?: {
				account?: {
					login?: string;
				} | null;
			};
			repository?: {
				owner?: {
					login?: string;
				} | null;
			};
			organization?: {
				login?: string;
			};
		};

		const accountLogin = payload?.installation?.account?.login;
		if (accountLogin && typeof accountLogin === 'string') {
			return accountLogin.toLowerCase();
		}

		const repoOwner = payload?.repository?.owner?.login;
		if (repoOwner && typeof repoOwner === 'string') {
			return repoOwner.toLowerCase();
		}

		const orgLogin = payload?.organization?.login;
		if (orgLogin && typeof orgLogin === 'string') {
			return orgLogin.toLowerCase();
		}

		return null;
	}

	/**
	 * Returns the Repo instance of the repository the event was delivered for.
	 * @returns The Repo for the event's repository
	 */
	protected repo(): Repo {
		return Repo.fromContext(this.context);
	}
}
