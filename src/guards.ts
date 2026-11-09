/**
 * Narrowing helpers for values whose shape is not ours to promise: provider
 * JSON, thrown errors, queue payloads. Each reads one field and checks its
 * type, so nothing is asserted that was not looked at.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** `value[key]` when `value` is an object, else `undefined`. */
export function field(value: unknown, key: string): unknown {
	return isRecord(value) ? value[key] : undefined;
}

export function stringField(value: unknown, key: string): string | undefined {
	const found = field(value, key);
	return typeof found === "string" ? found : undefined;
}

export function numberField(value: unknown, key: string): number | undefined {
	const found = field(value, key);
	return typeof found === "number" ? found : undefined;
}
