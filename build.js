import esbuild from 'esbuild';
import { clean } from 'esbuild-plugin-clean';
import path from 'node:path';

const outdir = 'dist';
const sourceRoot = 'src';

await esbuild.build({
	plugins: [clean({ patterns: [outdir] })],
	entryPoints: [path.join(sourceRoot, 'app.ts')],
	bundle: true,
	outdir,
	sourceRoot,
	platform: 'node',
	format: 'esm',
	minify: true
});
