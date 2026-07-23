import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import jsdoc from 'eslint-plugin-jsdoc';
import globals from 'globals';
import ts from 'typescript-eslint';

export default [
	{
		ignores: ['coverage/*', 'test-results/*', 'dist/*']
	},
	js.configs.recommended,
	...ts.configs.recommended,
	prettier,
	jsdoc.configs['flat/recommended-typescript'],
	{ languageOptions: { globals: { ...globals.node } } }
];
