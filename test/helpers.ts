import fs from 'fs';
import path from 'path';
import { Probot, ProbotOctokit } from 'probot';
import { fileURLToPath } from 'url';
import { test as baseTest } from 'vitest';
import { type LocalStackFixture, setupLocalStack } from './fixtures/localstack.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const privateKey = fs.readFileSync(path.join(__dirname, 'fixtures/mock-cert.pem'), 'utf-8');

export interface TestFixtures {
	probot: Probot;
	localstack: LocalStackFixture;
}

export const test = baseTest.extend<TestFixtures>({
	// eslint-disable-next-line no-empty-pattern
	probot: async ({}, use) => {
		const probot = new Probot({
			appId: 123,
			privateKey,
			// Disable request throttling and retries for testing
			Octokit: ProbotOctokit.defaults({
				retry: { enabled: false },
				throttle: { enabled: false }
			})
		});
		await use(probot);
	},
	// eslint-disable-next-line no-empty-pattern
	localstack: async ({}, use) => {
		const fixture = await setupLocalStack();
		await use(fixture);
		await fixture.stop();
	}
});
