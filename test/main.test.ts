import fs from 'fs';
import type { AddressInfo } from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it, vi } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const privateKey = fs.readFileSync(path.join(__dirname, 'fixtures/mock-cert.pem'), 'utf-8');

describe('main.ts', () => {
	it('starts and binds the express server to a port', async () => {
		vi.stubEnv('PORT', '0');
		vi.stubEnv('HOST', '127.0.0.1');
		vi.stubEnv('APP_ID', '123');
		vi.stubEnv('PRIVATE_KEY', privateKey);
		vi.stubEnv('WEBHOOK_SECRET', 'development');
		vi.stubEnv('GITHUB_CLIENT_ID', 'client-id');
		vi.stubEnv('GITHUB_CLIENT_SECRET', 'client-secret');
		vi.stubEnv('CLOUDFRONT_DOMAIN', 'assets.example.com');
		vi.stubEnv('CLOUDFRONT_PRIVATE_KEY', 'key');
		vi.stubEnv('CLOUDFRONT_KEY_PAIR_ID', 'key-pair-id');
		vi.stubEnv('S3_BUCKET_NAME', 'test-bucket');
		vi.stubEnv('SQS_QUEUE_URL', 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue');
		vi.stubEnv('ARTIFACT_PATTERNS', 'my-org/my-repo:.github/workflows/ci.yaml:build*');
		vi.stubEnv('JWT_SECRET', 'jwt-secret');

		const { default: server } = await import('../src/main.js');

		try {
			if (!server.listening) {
				await new Promise<void>((resolve) => server.once('listening', resolve));
			}
			const address = server.address() as AddressInfo;
			expect(address).toBeDefined();
			expect(address.port).toBeGreaterThan(0);
			expect(address.address).toBe('127.0.0.1');
		} finally {
			server.close();
		}
	});
});
