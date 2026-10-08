import esbuild from "esbuild";
import { clean } from "esbuild-plugin-clean";
import path from "node:path";

const outdir = "dist";
const sourceRoot = "src";

await esbuild.build({
  plugins: [clean({ patterns: [outdir] })],
  entryPoints: [path.resolve(sourceRoot, "aws-lambda.ts")],
  bundle: true,
  outfile: path.join(outdir, "aws-lambda.mjs"),
  sourceRoot,
  platform: "node",
  format: "esm",
  minify: false,
  packages: "external",
});
