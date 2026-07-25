import { Context } from 'probot';
import { BaseHandler } from './base.js';

/**
 * Handler for workflow run completed events on the runner repository.
 */
export default class WorkflowRunCompletedHandler extends BaseHandler<
	Context<'workflow_run.completed'>
> {
	async handle() {
		const { payload } = this.context;
		this.log.info(
			`Received workflow run completed event from repository ${payload.repository.full_name}.`
		);
	}
}
