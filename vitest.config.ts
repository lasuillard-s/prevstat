import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		hookTimeout: 180_000, // 3 minutes for integration tests with LocalStack
		testTimeout: 10_000,
		reporters: ['junit', 'default'],
		outputFile: {
			junit: './junit.xml'
		},
		coverage: {
			enabled: true,
			include: ['src/**'],
			exclude: ['src/**/*.d.ts', 'src/**/*.test.ts'],
			reporter: ['text', 'clover', 'html']
		},
		setupFiles: ['test/setup.ts']
	}
});
