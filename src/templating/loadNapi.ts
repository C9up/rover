// Loads the native `rover-template-engine-napi` binary built by
// `scripts/copy-napi.mjs` and re-throws load failures as
// `E_MAIL_TEMPLATE_NAPI_REQUIRED` (D55.2.4) — actionable hint points at
// `pnpm --filter @c9up/rover build:napi`.
//
// Per cerebrum 2026-04-15 there is NO JS fallback. If the binary fails to load,
// consumers get a typed `RoverError`. Zero `as` / `any` per `feedback_no_any_types`
// — every boundary is narrowed with a type guard.

import { RoverError } from "../RoverError.js";
import {
	hasFunctions,
	loadNativeBinary,
	muslHint,
	supportedTargets,
} from "../vendor/nativeBinary.js";

export type NativeRoverIr = import("../native/generated.js").RoverIr;

/**
 * What this package calls on the engine, typed as the Rust declares it.
 *
 * Derived from `../native/generated.js` — written by `pnpm build:napi-types`
 * from napi-derive's own `type-def` output — rather than restated here, where
 * nothing would notice a `pub fn` gaining a parameter or changing its return.
 * The guard below checks the same calls at load: a declaration says what the
 * Rust promises, not what a stale binary shipped.
 */
const NATIVE_CALLS = ["compile", "renderIr"] as const;

type NativeExports = Pick<
	typeof import("../native/generated.js"),
	(typeof NATIVE_CALLS)[number]
>;

function isNativeExports(value: unknown): value is NativeExports {
	return hasFunctions(value, NATIVE_CALLS);
}

let cachedNative: NativeExports | undefined;

export function getNative(): NativeExports {
	if (cachedNative !== undefined) return cachedNative;

	// The resolution and the export check are shared; the refusals are rover's,
	// with rover's code on them.
	const attempt = loadNativeBinary(isNativeExports, NATIVE_CALLS);
	if (attempt.loaded) {
		cachedNative = attempt.binary;
		return cachedNative;
	}
	const { suffix, cause } = attempt;
	if (suffix === undefined) {
		throw new RoverError(
			"E_MAIL_TEMPLATE_NAPI_REQUIRED",
			`No @c9up/rover native binary for this platform. Supported: ${supportedTargets().join(", ")}.`,
			{
				hint: "Build the native binary on a supported platform with 'pnpm --filter @c9up/rover build:napi'.",
			},
		);
	}
	const causeMessage = cause instanceof Error ? cause.message : String(cause);
	throw new RoverError(
		"E_MAIL_TEMPLATE_NAPI_REQUIRED",
		`@c9up/rover native binary 'index.${suffix}.node' not found, failed to load, or is stale — run 'pnpm --filter @c9up/rover build:napi' to build it.${muslHint()} Cause: ${causeMessage}`,
		{
			hint: "Run 'pnpm --filter @c9up/rover build:napi' to compile the native template engine.",
		},
	);
}

/**
 * Shape of the JSON payload Rust packs into `napi::Error::from_reason`. Rust
 * guarantees `code` + `message` are present.
 */
interface NapiErrorPayload {
	readonly code: string;
	readonly message: string;
}

function isNapiErrorPayload(value: unknown): value is NapiErrorPayload {
	if (value === null || typeof value !== "object") return false;
	return (
		typeof Reflect.get(value, "code") === "string" &&
		typeof Reflect.get(value, "message") === "string"
	);
}

/** Codes the Rust engine legitimately emits, with their actionable hints. */
const CODE_HINTS: Readonly<Record<string, string>> = {
	E_MAIL_TEMPLATE_SYNTAX:
		"Check the template grammar: {{ var }}, {{{ raw }}}, {{#if x}}...{{/if}}, {{> partial}}.",
	MAIL_TEMPLATE_RECURSION:
		"Break the cycle — a template cannot include itself (directly or via partials).",
	E_MAIL_TEMPLATE_NOT_FOUND:
		"Create the referenced partial file or remove the {{> name}} reference.",
};

/**
 * Translate a thrown value from a native call into a `RoverError`.
 * Already a `RoverError` (e.g. the loader threw) → pass through. A `napi::Error`
 * carrying our `{code,message}` JSON envelope → reconstruct typed (line numbers
 * preserved in `message`). Anything else → wrap as a syntax error.
 */
export function toReamError(err: unknown): RoverError {
	if (err instanceof RoverError) return err;
	if (err instanceof Error) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(err.message);
		} catch {
			parsed = undefined;
		}
		if (isNapiErrorPayload(parsed)) {
			const hint = CODE_HINTS[parsed.code];
			if (hint !== undefined) {
				return new RoverError(parsed.code, parsed.message, { hint });
			}
		}
		return new RoverError(
			"E_MAIL_TEMPLATE_SYNTAX",
			`Native template call failed: ${err.message}`,
		);
	}
	return new RoverError(
		"E_MAIL_TEMPLATE_SYNTAX",
		`Native template call failed with non-Error: ${String(err)}`,
	);
}
