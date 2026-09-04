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

/**
 * The `RequestInit` of the nth recorded `fetch`.
 *
 * The shape this replaces was `(spy.mock.calls[0]?.[1] as RequestInit).body`:
 * an optional chain that yields `undefined`, an assertion claiming it is a
 * `RequestInit`, and then a property read on it. The chain protects nothing —
 * the read throws exactly as it would without it — and the assertion is what
 * kept the compiler from saying so.
 */
export function requestInit(
	calls: ReadonlyArray<readonly unknown[]>,
	nth = 0,
): RequestInit {
	const call = calls[nth];
	if (call === undefined) throw new Error(`no fetch call #${nth}`);
	const init = call[1];
	if (typeof init !== "object" || init === null) {
		throw new Error(`fetch call #${nth} carried no init`);
	}
	return init;
}

/** The headers of the nth recorded `fetch`, as a plain string map. */
export function requestHeaders(
	calls: ReadonlyArray<readonly unknown[]>,
	nth = 0,
): Record<string, string> {
	const headers = requestInit(calls, nth).headers;
	if (typeof headers !== "object" || headers === null) {
		throw new Error(`fetch call #${nth} carried no headers`);
	}
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (typeof value === "string") out[key] = value;
	}
	return out;
}

/** One field of an object a listener was handed, proven to be a string. */
export function stringField(value: unknown, name: string): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const field = Reflect.get(value, name);
	return typeof field === "string" ? field : undefined;
}

/** The body of the nth recorded `fetch`, as the string a form post carries. */
export function requestBody(
	calls: ReadonlyArray<readonly unknown[]>,
	nth = 0,
): string {
	const body = requestInit(calls, nth).body;
	if (typeof body === "string") return body;
	if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
	throw new Error(`fetch call #${nth} carried no text body`);
}
