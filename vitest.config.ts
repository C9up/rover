import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// send-later.test.ts drives a real @c9up/bay queue — a monorepo-level
		// integration test that can't run in the standalone repo.
			// `src/vendor/**` is generated from scripts/vendor/ and identical in every
			// package that carries it, so measuring it here counts the same lines N
			// times and holds this package to a floor for code it cannot change. The
			// behaviour is pinned where it broke: bay's quasar-bridge suite covers the
			// two manager shapes the loader has to accept.
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"tests/unit/send-later.test.ts",
		],
		coverage: {
			provider: "v8",
			include: ["src/**"],
			exclude: ["src/**/*.d.ts", "src/vendor/**"],
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
