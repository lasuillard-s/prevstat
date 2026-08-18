import { S3Client } from '@aws-sdk/client-s3';
import AdmZip from 'adm-zip';
import { Context } from 'probot';
import { beforeEach, describe, expect, vi } from 'vitest';
import { AppConfig } from '../../src/config.js';
import WorkflowRunCompletedHandler from '../../src/handlers/workflow_run.completed.js';
import { test as it } from '../helpers.js';

describe('WorkflowRunCompletedHandler', () => {
	let appConfig: AppConfig;
	let mockS3Client: S3Client;
	let mockSend: ReturnType<typeof vi.fn>;
	let mockOctokit: {
		rest: {
			actions: {
				listWorkflowRunArtifacts: ReturnType<typeof vi.fn>;
				downloadArtifact: ReturnType<typeof vi.fn>;
			};
			checks: {
				create: ReturnType<typeof vi.fn>;
			};
		};
	};
	let mockLog: {
		debug: ReturnType<typeof vi.fn>;
		info: ReturnType<typeof vi.fn>;
		warn: ReturnType<typeof vi.fn>;
		error: ReturnType<typeof vi.fn>;
	};

	const createZipBuffer = (files: Record<string, string>): Buffer => {
		const zip = new AdmZip();
		for (const [filename, content] of Object.entries(files)) {
			zip.addFile(filename, Buffer.from(content));
		}
		return zip.toBuffer();
	};

	beforeEach(() => {
		appConfig = {
			GITHUB_CLIENT_ID: 'client-id',
			GITHUB_CLIENT_SECRET: 'client-secret',
			CLOUDFRONT_DOMAIN: 'assets.example.com',
			CLOUDFRONT_PRIVATE_KEY: 'key',
			CLOUDFRONT_KEY_PAIR_ID: 'key-pair-id',
			CLOUDFRONT_SIGNED_COOKIE_EXPIRATION_SECONDS: 900,
			JWT_SECRET: 'jwt-secret',
			JWT_EXPIRATION_SECONDS: 300,
			S3_BUCKET_NAME: 'test-bucket',
			ARTIFACT_PATTERNS: ['my-org/my-repo:.github/workflows/ci.yaml:build-output*']
		};

		mockSend = vi.fn().mockResolvedValue({});
		mockS3Client = {
			send: mockSend
		} as unknown as S3Client;

		mockOctokit = {
			rest: {
				actions: {
					listWorkflowRunArtifacts: vi.fn(),
					downloadArtifact: vi.fn()
				},
				checks: {
					create: vi.fn().mockResolvedValue({})
				}
			}
		};

		mockLog = {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn()
		};
	});

	const createHandler = (
		payloadOverrides: Record<string, unknown> = {},
		s3Client: S3Client = mockS3Client
	) => {
		const payload = {
			repository: {
				name: 'my-repo',
				full_name: 'my-org/my-repo',
				private: true,
				owner: {
					login: 'my-org'
				}
			},
			workflow_run: {
				id: 12345,
				name: 'CI',
				path: '.github/workflows/ci.yaml',
				head_sha: 'abcdef123456'
			},
			...payloadOverrides
		};

		const context = {
			payload,
			octokit: mockOctokit,
			log: mockLog,
			repo: () => ({ owner: 'my-org', repo: 'my-repo' })
		} as unknown as Context<'workflow_run.completed'>;

		return new WorkflowRunCompletedHandler(context, appConfig, s3Client);
	};

	it('skips artifacts that do not match ARTIFACT_PATTERNS', async () => {
		mockOctokit.rest.actions.listWorkflowRunArtifacts.mockResolvedValue({
			data: {
				artifacts: [{ id: 1, name: 'other-artifact' }]
			}
		});

		const handler = createHandler();
		await handler.handle();

		expect(mockOctokit.rest.actions.downloadArtifact).not.toHaveBeenCalled();
		expect(mockSend).not.toHaveBeenCalled();
		expect(mockOctokit.rest.checks.create).not.toHaveBeenCalled();
	});

	it('downloads, unzips, uploads matched artifact, and creates check run with success conclusion', async () => {
		const zipBuffer = createZipBuffer({
			'index.html': '<html>Hello World</html>',
			'styles/main.css': 'body { color: blue; }'
		});

		mockOctokit.rest.actions.listWorkflowRunArtifacts.mockResolvedValue({
			data: {
				artifacts: [{ id: 101, name: 'build-output-web' }]
			}
		});

		mockOctokit.rest.actions.downloadArtifact.mockResolvedValue({
			data: zipBuffer.buffer.slice(
				zipBuffer.byteOffset,
				zipBuffer.byteOffset + zipBuffer.byteLength
			)
		});

		const handler = createHandler();
		await handler.handle();

		expect(mockOctokit.rest.actions.downloadArtifact).toHaveBeenCalledWith({
			owner: 'my-org',
			repo: 'my-repo',
			artifact_id: 101,
			archive_format: 'zip'
		});

		expect(mockSend).toHaveBeenCalledTimes(2);
		expect(mockSend).toHaveBeenCalledWith(
			expect.objectContaining({
				input: expect.objectContaining({
					Bucket: 'test-bucket',
					Key: 'private/my-org/my-repo/12345/build-output-web/index.html',
					ContentType: 'text/html'
				})
			})
		);
		expect(mockSend).toHaveBeenCalledWith(
			expect.objectContaining({
				input: expect.objectContaining({
					Bucket: 'test-bucket',
					Key: 'private/my-org/my-repo/12345/build-output-web/styles/main.css',
					ContentType: 'text/css'
				})
			})
		);

		expect(mockOctokit.rest.checks.create).toHaveBeenCalledWith({
			owner: 'my-org',
			repo: 'my-repo',
			name: 'build-output-web',
			head_sha: 'abcdef123456',
			status: 'completed',
			conclusion: 'success',
			details_url:
				'https://assets.example.com/private/my-org/my-repo/12345/build-output-web/index.html',
			output: {
				title: 'Artifact: build-output-web',
				summary: 'Successfully uploaded artifact build-output-web to S3.'
			}
		});
	});

	it('handles listWorkflowRunArtifacts errors gracefully', async () => {
		mockOctokit.rest.actions.listWorkflowRunArtifacts.mockRejectedValue(new Error('Network error'));

		const handler = createHandler();
		await expect(handler.handle()).resolves.not.toThrow();

		expect(mockOctokit.rest.actions.downloadArtifact).not.toHaveBeenCalled();
		expect(mockSend).not.toHaveBeenCalled();
		expect(mockOctokit.rest.checks.create).not.toHaveBeenCalled();
	});

	it('handles downloadArtifact failure gracefully without creating check run', async () => {
		mockOctokit.rest.actions.listWorkflowRunArtifacts.mockResolvedValue({
			data: {
				artifacts: [{ id: 101, name: 'build-output-web' }]
			}
		});
		mockOctokit.rest.actions.downloadArtifact.mockRejectedValue(new Error('Not found'));

		const handler = createHandler();
		await expect(handler.handle()).resolves.not.toThrow();

		expect(mockSend).not.toHaveBeenCalled();
		expect(mockOctokit.rest.checks.create).not.toHaveBeenCalled();
	});

	it('creates check run with failure conclusion when S3 upload fails', async () => {
		const zipBuffer = createZipBuffer({
			'index.html': '<html>Hello World</html>'
		});

		mockOctokit.rest.actions.listWorkflowRunArtifacts.mockResolvedValue({
			data: {
				artifacts: [{ id: 101, name: 'build-output-web' }]
			}
		});
		mockOctokit.rest.actions.downloadArtifact.mockResolvedValue({
			data: zipBuffer.buffer.slice(
				zipBuffer.byteOffset,
				zipBuffer.byteOffset + zipBuffer.byteLength
			)
		});
		mockSend.mockRejectedValue(new Error('S3 Access Denied'));

		const handler = createHandler();
		await handler.handle();

		expect(mockOctokit.rest.checks.create).toHaveBeenCalledWith({
			owner: 'my-org',
			repo: 'my-repo',
			name: 'build-output-web',
			head_sha: 'abcdef123456',
			status: 'completed',
			conclusion: 'failure',
			details_url:
				'https://assets.example.com/private/my-org/my-repo/12345/build-output-web/index.html',
			output: {
				title: 'Artifact: build-output-web',
				summary: 'Failed to upload artifact build-output-web to S3.'
			}
		});
	});

	it('handles corrupt zip archives gracefully and reports failure check run', async () => {
		mockOctokit.rest.actions.listWorkflowRunArtifacts.mockResolvedValue({
			data: {
				artifacts: [{ id: 101, name: 'build-output-web' }]
			}
		});
		mockOctokit.rest.actions.downloadArtifact.mockResolvedValue({
			data: Buffer.from('invalid-non-zip-data')
		});

		const handler = createHandler();
		await handler.handle();

		expect(mockOctokit.rest.checks.create).toHaveBeenCalledWith(
			expect.objectContaining({
				conclusion: 'failure'
			})
		);
	});

	it('handles check run creation errors gracefully', async () => {
		const zipBuffer = createZipBuffer({
			'index.html': '<html>Hello World</html>'
		});

		mockOctokit.rest.actions.listWorkflowRunArtifacts.mockResolvedValue({
			data: {
				artifacts: [{ id: 101, name: 'build-output-web' }]
			}
		});
		mockOctokit.rest.actions.downloadArtifact.mockResolvedValue({
			data: zipBuffer.buffer.slice(
				zipBuffer.byteOffset,
				zipBuffer.byteOffset + zipBuffer.byteLength
			)
		});
		mockOctokit.rest.checks.create.mockRejectedValue(new Error('GitHub API down'));

		const handler = createHandler();
		await expect(handler.handle()).resolves.not.toThrow();
	});
});
