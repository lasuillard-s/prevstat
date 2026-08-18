import { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Context } from 'probot';
import { AppConfig } from '../config.js';
import { ProcessArtifactMessage } from '../sqs.js';
import { matchPatterns } from '../utils.js';
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

		await this.enqueueArtifacts(matchedArtifacts);
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

	private async enqueueArtifacts(artifacts: Array<{ id: number; name: string }>) {
		const { payload } = this.context;

		const chunkSize = 10;
		for (let i = 0; i < artifacts.length; i += chunkSize) {
			const chunk = artifacts.slice(i, i + chunkSize);
			const entries = chunk.map((artifact) => {
				const message: ProcessArtifactMessage = {
					installationId: payload.installation?.id,
					repository: {
						name: payload.repository.name,
						full_name: payload.repository.full_name,
						private: payload.repository.private,
						owner: {
							login: payload.repository.owner.login
						}
					},
					workflowRun: {
						id: payload.workflow_run.id,
						name: payload.workflow_run.name,
						path: payload.workflow_run.path,
						head_sha: payload.workflow_run.head_sha
					},
					artifact: {
						id: artifact.id,
						name: artifact.name
					}
				};

				return {
					Id: artifact.id.toString(),
					MessageBody: JSON.stringify(message)
				};
			});

			try {
				const result = await this.sqsClient.send(
					new SendMessageBatchCommand({
						QueueUrl: this.appConfig.SQS_QUEUE_URL,
						Entries: entries
					})
				);

				if (result.Failed && result.Failed.length > 0) {
					for (const failed of result.Failed) {
						this.log.error(
							`Failed to enqueue artifact entry ${failed.Id}: ${failed.Message} (${failed.Code})`
						);
					}
				}
				if (result.Successful && result.Successful.length > 0) {
					this.log.info(`Enqueued ${result.Successful.length} artifact(s) to SQS.`);
				}
			} catch (error) {
				this.log.error(error, 'Failed to send artifact batch to SQS');
			}
		}
	}
}
