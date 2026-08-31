import esbuild from 'esbuild';
import { clean } from 'esbuild-plugin-clean';
import path from 'node:path';

const outdir = 'dist';
const sourceRoot = 'src';

await esbuild.build({
	plugins: [clean({ patterns: [outdir] })],
	entryPoints: [path.join(sourceRoot, 'aws-lambda.ts')],
	bundle: true,
	outfile: path.join(outdir, 'aws-lambda.mjs'),
	sourceRoot,
	platform: 'node',
	format: 'esm',
	minify: true,
	banner: {
		// Workaround for 'Error: Dynamic require of "node:path" is not supported';
		// https://github.com/aws/aws-sam-cli/issues/4827
		js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`
	},
	external: [
		// Included in Lambda Node.js runtime by default
		// https://docs.aws.amazon.com/lambda/latest/dg/lambda-nodejs.html
		'@aws-sdk/*'
	]
});
