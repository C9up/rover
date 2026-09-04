/**
 * Narrow away `undefined` without a `!` assertion.
 *
 * `noUncheckedIndexedAccess` types `list[0]` as possibly absent, which is true
 * of an arbitrary index and not of the one a test just produced. A `!` would
 * silence that by asserting; this proves it, and a fixture that stopped
 * producing the element fails on the line that reads it rather than several
 * frames later on a property of `undefined`.
 */
export function defined<T>(value: T | null | undefined, what = "value"): T {
	if (value == null) throw new Error(`expected a defined ${what}`);
	return value;
}
