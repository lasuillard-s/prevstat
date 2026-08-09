import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import jsdoc from 'eslint-plugin-jsdoc';
import { includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-eslint';

const gitignorePath = fileURLToPath(new URL('.gitignore', import.meta.url));

export default [
	includeIgnoreFile(gitignorePath, { gitignoreResolution: true }),
	js.configs.recommended,
	...ts.configs.recommended,
	prettier,
	...jsdoc.configs['flat/recommended-mixed'],
	{ languageOptions: { globals: { ...globals.node } } }
];
