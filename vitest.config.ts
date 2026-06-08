import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// send-later.test.ts drives a real @c9up/bay queue — a monorepo-level
		// integration test that can't run in the standalone repo.
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"tests/unit/send-later.test.ts",
		],
		coverage: {
			provider: "v8",
			include: ["src/**"],
			exclude: ["src/**/*.d.ts"],
			reporter: ["text-summary", "json-summary"],
			thresholds: {
				lines: 91,
				statements: 89,
				branches: 81,
				functions: 88,
			},
		},
	},
});
