import fs from 'fs';
import path from 'path';
import { Probot, ProbotOctokit } from 'probot';
import { fileURLToPath } from 'url';
import { test as baseTest } from 'vitest';
import app from '../src/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const privateKey = fs.readFileSync(path.join(__dirname, 'fixtures/mock-cert.pem'), 'utf-8');

export const test = baseTest.extend('probot', async () => {
	const probot = new Probot({
		appId: 123,
		privateKey,
		// Disable request throttling and retries for testing
		Octokit: ProbotOctokit.defaults({
			retry: { enabled: false },
			throttle: { enabled: false }
		})
	});
	await probot.load(app);
	return probot;
});
