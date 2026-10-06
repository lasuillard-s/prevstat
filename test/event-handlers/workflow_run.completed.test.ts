import nock from 'nock';
import { beforeEach, describe, expect, vi } from 'vitest';
import payload from '../fixtures/workflow_run.completed.json' with { type: 'json' };
import { test as it } from '../helpers.js';

describe('when principal is unauthorized on workflow_run.completed', () => {
	beforeEach(() => {
		vi.stubEnv('ALLOWED_PRINCIPALS', 'authorized-org-only');
	});

	it('skips processing without making any API calls', async ({ probot }) => {
		const mock = nock('https://api.github.com');

		// @ts-expect-error Ignore fixture modification
		await probot.receive({ id: '', name: 'workflow_run.completed', payload });

		expect(mock.isDone()).toBe(true);
		expect(mock.pendingMocks()).toStrictEqual([]);
	});
});
