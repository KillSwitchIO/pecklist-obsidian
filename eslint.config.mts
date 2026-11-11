import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
		'tests',
		'vitest.config.ts',
		'vitest.contract.config.ts',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		rules: {
			// PeckList and the Tasks plugin are names; tags, addresses and quoted command names stay as written.
			'obsidianmd/ui/sentence-case': [
				'warn',
				{
					ignoreWords: ['PeckList', 'Tasks', 'Obsidian', 'API'],
					ignoreRegex: ['#pecklist(/\\w+)?', 'https?://\\S+', '"[^"]+"'],
				},
			],
		},
	},
);
