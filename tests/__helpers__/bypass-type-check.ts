/**
 * Single encapsulation point for runtime-bad-value injection in tests.
 *
 * The DNR (`feedback_no_any_types`) forbids `as T` casts in new code.
 * This helper concentrates the unavoidable structural cast at the only
 * legitimate boundary: feeding deliberately malformed values into a
 * function whose runtime hardening we want to test.
 *
 * Use SPARINGLY — only when the test deliberately violates the static
 * type contract to verify a runtime guard. Prefer well-typed factories
 * for all other cases.
 *
 * Mirrors `packages/ream/tests/__helpers__/bypass-type-check.ts` —
 * imported separately to keep rover tests free of `@c9up/ream` dep.
 */
export function bypassTypeCheck<T>(value: unknown): T {
	return value as T;
}
