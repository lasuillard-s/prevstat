import { Context, Probot } from 'probot';
import { AppConfig } from '../config.js';
import { BaseHandler } from './base.js';

/**
 * Handler for GitHub App installation.created and installation.unsuspend events.
 *
 * Enforces user access control by checking the installation's principal against
 * `ALLOWED_PRINCIPALS`. If configured and the principal is unauthorized, the installation
 * is immediately deleted/uninstalled.
 */
export default class InstallationHandler extends BaseHandler<
	Context<'installation.created' | 'installation.unsuspend'>
> {
	private readonly app: Probot;

	constructor(
		context: Context<'installation.created' | 'installation.unsuspend'>,
		appConfig: AppConfig,
		app: Probot
	) {
		super(context, appConfig);
		this.app = app;
	}

	/**
	 * Overrides BaseHandler.execute().
	 *
	 * Unlike other event handlers that skip processing for unauthorized principals,
	 * InstallationHandler must execute even when the principal is unauthorized so that
	 * it can automatically uninstall/delete the unauthorized installation.
	 */
	override async execute(): Promise<void> {
		await this.handle();
	}

	async handle(): Promise<void> {
		const allowedPrincipals = this.appConfig.ALLOWED_PRINCIPALS;

		// If ALLOWED_PRINCIPALS is set to allow-all ('*'), skip the access control check.
		if (allowedPrincipals.includes('*')) {
			this.log.debug(
				'ALLOWED_PRINCIPALS is set to allow-all; skipping installation access control check.'
			);
			return;
		}

		// Check the principal of the installation against the allowed principals list.
		const principal = this.getPrincipal();
		const installationId = this.context.payload.installation.id;
		const action = this.context.payload.action;

		if (!principal) {
			this.log.warn(
				`Installation ${installationId} has no recognizable account login; treating as unauthorized and uninstalling...`
			);
			await this.uninstallInstallation(installationId, 'unknown');
			return;
		}

		if (!this.isAuthorized()) {
			this.log.warn(
				`Installation ${installationId} ${action} by unauthorized principal: "${principal}". Uninstalling...`
			);
			await this.uninstallInstallation(installationId, principal);
		} else {
			this.log.info(
				`Installation ${installationId} ${action} by authorized principal: "${principal}".`
			);
		}
	}

	/**
	 * Uninstalls the GitHub app for a given installation ID.
	 * @param installationId The ID of the installation to delete
	 * @param principal Label used for logging (e.g. principal login or 'unknown')
	 */
	private async uninstallInstallation(installationId: number, principal: string): Promise<void> {
		try {
			const appOctokit = await this.app.auth();
			await appOctokit.rest.apps.deleteInstallation({
				installation_id: installationId
			});
			this.log.info(
				`Deleted installation ${installationId} for unauthorized principal: "${principal}".`
			);
		} catch (error) {
			this.log.error(
				{ error },
				`Failed to delete installation ${installationId} for unauthorized principal "${principal}"`
			);
		}
	}
}
