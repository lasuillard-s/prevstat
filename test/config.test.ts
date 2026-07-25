import { Probot } from 'probot';
import { beforeEach, describe, expect, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { test as it } from './helpers.js';

describe('loadConfig', () => {
	let probot: Probot;

	beforeEach(() => {
		probot = {
			log: {
				error: vi.fn()
			}
		} as unknown as Probot;
	});

	it('loads valid config with reasonable defaults', () => {
		// Arrange (required only)
		vi.stubEnv('RUNNER_REPOSITORY', 'acme/devcontainer-check-runner');

		// Act & Assert
		const config = loadConfig(probot);
		expect(config).toMatchObject({
			EXAMPLE: 'default'
		});
	});

	it('loads valid config with explicit configuration values', () => {
		// Arrange
		vi.stubEnv('EXAMPLE', 'explicit');

		// Act & Assert
		const config = loadConfig(probot);
		expect(config).toMatchObject({
			EXAMPLE: 'explicit'
		});
	});
});
