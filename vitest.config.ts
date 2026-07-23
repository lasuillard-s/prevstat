import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
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
