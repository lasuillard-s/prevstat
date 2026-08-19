import { SQSClient } from '@aws-sdk/client-sqs';
import { Context } from 'probot';
import { AppConfig } from '../config.js';
import { submitArtifactProcessingTasks } from '../lib/aws/sqs.js';
import { matchPatterns } from '../utils/string.js';
import { BaseHandler } from './base.js';

/**
 * Handler for workflow run completed events on the runner repository.
 * Enqueues matching artifacts to SQS for asynchronous processing.
 */
export default class WorkflowRunCompletedHandler extends BaseHandler<
	Context<'workflow_run.completed'>
> {
	private readonly sqsClient: SQSClient;

	constructor(
		context: Context<'workflow_run.completed'>,
		appConfig: AppConfig,
		sqsClient?: SQSClient
	) {
		super(context, appConfig);
		this.sqsClient = sqsClient ?? new SQSClient({});
	}

	async handle() {
		const { payload } = this.context;

		this.log.debug(
			`Received workflow run completed event from repository ${payload.repository.full_name}, workflow ${payload.workflow_run.path}.`
		);

		const artifacts = await this.listArtifacts();
		const matchedArtifacts = artifacts.filter((artifact) => {
			const artifactFqn = `${payload.repository.full_name}:${payload.workflow_run.path}:${artifact.name}`;
			return this.isArtifactMatched(artifactFqn);
		});

		if (matchedArtifacts.length === 0) return;

		try {
			await submitArtifactProcessingTasks(
				this.sqsClient,
				this.appConfig.SQS_QUEUE_URL,
				{
					installationId: payload.installation?.id,
					owner: payload.repository.owner.login,
					repo: payload.repository.name,
					runId: payload.workflow_run.id
				},
				matchedArtifacts.map((artifact) => artifact.id)
			);
			this.log.info(`Enqueued ${matchedArtifacts.length} artifact(s) to SQS.`);
		} catch (error) {
			this.log.error(error, 'Failed to send artifact batch to SQS');
		}
	}

	private async listArtifacts() {
		const { payload, octokit } = this.context;
		const { owner, repo } = this.repo();
		try {
			const { data } = await octokit.rest.actions.listWorkflowRunArtifacts({
				owner,
				repo,
				run_id: payload.workflow_run.id
			});
			return data.artifacts;
		} catch (error) {
			this.log.error(error, `Failed to list artifacts for workflow run ${payload.workflow_run.id}`);
			return [];
		}
	}

	private isArtifactMatched(artifactFqn: string): boolean {
		return matchPatterns(artifactFqn, this.appConfig.ARTIFACT_PATTERNS, {});
	}
}
