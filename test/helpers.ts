import { LocalstackContainer } from '@testcontainers/localstack';
import fs from 'fs';
import path from 'path';
import { Probot, ProbotOctokit } from 'probot';
import { fileURLToPath } from 'url';
import { test as baseTest } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const privateKey = fs.readFileSync(path.join(__dirname, 'fixtures/mock-cert.pem'), 'utf-8');

export interface TestFixtures {
	probot: Probot;
	localstack: URL;
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
	localstack: [
		// eslint-disable-next-line no-empty-pattern
		async ({}, use) => {
			// NOTE: LocalStack 4 enforces auth tokens, so we use LocalStack 3.x for testing to avoid authentication issues.
			const container = await new LocalstackContainer('localstack/localstack:3.8.1').start();
			const endpoint = new URL(container.getConnectionUri());
			try {
				await use(endpoint);
			} finally {
				await container.stop();
			}
		},
		{ scope: 'worker' }
	]
});
