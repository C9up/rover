// Loads rover's native template engine: the local build (`index.<suffix>.node`
// at the package root, written by `scripts/copy-napi.mjs`) when there is one,
// else the platform package `@c9up/rover-<suffix>` the package manager
// installed as an optional dependency. A failure throws
// `E_MAIL_TEMPLATE_NAPI_REQUIRED`, whose message and `help` say what to do and
// whose `cause` is the load error.
//
// There is no JavaScript fallback: without the engine, no template renders.

import { arch, platform } from "node:process";
import { Exception } from "@c9up/flare";
import {
	E_MAIL_TEMPLATE_NAPI_REQUIRED,
	E_MAIL_TEMPLATE_NOT_FOUND,
	E_MAIL_TEMPLATE_RECURSION,
	E_MAIL_TEMPLATE_SYNTAX,
} from "../errors.js";
import { withHelp } from "../help.js";
import {
	hasFunctions,
	loadNativeBinary,
	muslHint,
	supportedTargets,
} from "../vendor/nativeBinary.js";

/**
 * The npm name the platform packages derive from: `@c9up/rover-<suffix>`,
 * one per target, each an optional dependency pinned to this version.
 */
const PACKAGE_NAME = "@c9up/rover";

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

	// The resolution and the export check are shared; the refusal is rover's,
	// with rover's code on it.
	const attempt = loadNativeBinary(isNativeExports, NATIVE_CALLS, {
		packageName: PACKAGE_NAME,
	});
	if (attempt.loaded) {
		cachedNative = attempt.binary;
		return cachedNative;
	}
	const fix = remedy(attempt.suffix, attempt.platformPackage);
	throw withHelp(
		new E_MAIL_TEMPLATE_NAPI_REQUIRED(
			[
				"The rover Rust template engine is required but not loaded.\n" +
					`  Fix: ${fix}`,
			],
			attempt.cause === undefined ? undefined : { cause: attempt.cause },
		),
		fix,
	);
}

/**
 * What to do about a missing engine, phrased for whoever has to fix it.
 *
 * An application installs the platform package; a checkout of rover builds
 * the local binary. The load error itself is not in here: it names paths on
 * the host, so it travels as the refusal's `cause` instead of its message.
 */
function remedy(
	suffix: string | undefined,
	platformPackage: string | undefined,
): string {
	if (suffix === undefined) {
		return `no prebuilt binary for ${platform}-${arch}; rover ships one for ${supportedTargets().join(", ")}.`;
	}
	if (platformPackage === undefined) {
		return `index.${suffix}.node failed to load. Rebuild it: cd packages/rover && pnpm build:napi`;
	}
	return (
		`install ${platformPackage} at the exact version of ${PACKAGE_NAME}: it is the optional dependency that carries the ${suffix} binary, ` +
		"and an install that omits optional dependencies skips it. " +
		`In a checkout of rover, build it instead: pnpm build:napi.${muslHint()}`
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

/**
 * The codes the Rust engine puts in its `{code,message}` envelope, each with
 * the class it maps to and an actionable help text.
 */
const NATIVE_ERRORS: Readonly<
	Record<string, (message: string, cause: Error) => Exception>
> = {
	E_MAIL_TEMPLATE_SYNTAX: (message, cause) =>
		withHelp(
			new E_MAIL_TEMPLATE_SYNTAX([message], { cause }),
			"Check the template grammar: {{ var }}, {{{ raw }}}, {{#if x}}...{{/if}}, {{> partial}}.",
		),
	E_MAIL_TEMPLATE_RECURSION: (message, cause) =>
		withHelp(
			new E_MAIL_TEMPLATE_RECURSION([message], { cause }),
			"Break the cycle — a template cannot include itself (directly or via partials).",
		),
	E_MAIL_TEMPLATE_NOT_FOUND: (message, cause) =>
		new E_MAIL_TEMPLATE_NOT_FOUND(
			message,
			{},
			{
				help: "Create the referenced partial file or remove the {{> name}} reference.",
				cause,
			},
		),
};

/**
 * Translate a thrown value from a native call into a rover error. Already
 * one (e.g. the loader threw) → pass through. A `napi::Error` carrying our
 * `{code,message}` JSON envelope → the matching class, the native error as
 * `cause` (line numbers preserved in `message`). Anything else → wrap as a
 * syntax error.
 */
export function toReamError(err: unknown): Exception {
	if (err instanceof Exception) return err;
	if (err instanceof Error) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(err.message);
		} catch {
			parsed = undefined;
		}
		if (isNapiErrorPayload(parsed)) {
			const build = NATIVE_ERRORS[parsed.code];
			if (build !== undefined) return build(parsed.message, err);
		}
		return new E_MAIL_TEMPLATE_SYNTAX(
			[`Native template call failed: ${err.message}`],
			{ cause: err },
		);
	}
	return new E_MAIL_TEMPLATE_SYNTAX([
		`Native template call failed with non-Error: ${String(err)}`,
	]);
}
