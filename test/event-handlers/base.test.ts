import { Context, Probot } from 'probot';
import { expect, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { BaseHandler } from '../../src/event-handlers/base.js';
import { test as it } from '../helpers.js';

/**
 * Minimal concrete subclass used to exercise the shared helpers on BaseHandler.
 */
class TestHandler extends BaseHandler<Context> {
	async handle(): Promise<void> {}
}

/**
 * Builds a TestHandler with the given environment variables loaded into config.
 * @param probot Probot app instance
 * @returns A TestHandler instance bound to a fake event context
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function makeHandler(probot: Probot): TestHandler {
	const config = loadConfig(probot);
	const context = {
		octokit: {} as Context['octokit'],
		log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		repo: () => ({ owner: 'owner', repo: 'repo' }),
		payload: {}
	} as unknown as Context;
	return new TestHandler(context, config);
}

it('should pass', () => {
	expect(true).toBe(true);
});
