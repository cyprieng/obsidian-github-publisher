import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import eslintConfigPrettier from "eslint-config-prettier/flat";

export default defineConfig([
	{
		ignores: ["*.mjs", "node_modules/", "main.js"],
	},
	...obsidianmd.configs.recommended,
	eslintConfigPrettier,
	eslintPluginPrettierRecommended,
	{
		files: ["**/*.ts"],
		extends: [...tseslint.configs.recommended],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
]);
