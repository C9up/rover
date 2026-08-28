// Loads the native `rover-template-engine-napi` binary built by
// `scripts/copy-napi.mjs` and re-throws load failures as
// `MAIL_TEMPLATE_NAPI_REQUIRED` (D55.2.4) — actionable hint points at
// `pnpm --filter @c9up/rover build:napi`.
//
// Per cerebrum 2026-04-15 there is NO JS fallback. If the binary fails to load,
// consumers get a typed `RoverError`. Zero `as` / `any` per `feedback_no_any_types`
// — every boundary is narrowed with a `Reflect.get` type guard.

import { createRequire } from "node:module";
import { arch, platform } from "node:process";
import { fileURLToPath } from "node:url";
import { RoverError } from "../RoverError.js";

const SUFFIX_MAP: Readonly<Record<string, string>> = {
	"linux-x64": "linux-x64-gnu",
	"linux-arm64": "linux-arm64-gnu",
	"darwin-x64": "darwin-x64",
	"darwin-arm64": "darwin-arm64",
	"win32-x64": "win32-x64-msvc",
};

function platformSuffix(): string {
	const key = `${platform}-${arch}`;
	const suffix = SUFFIX_MAP[key];
	if (typeof suffix !== "string") {
		throw new RoverError(
			"MAIL_TEMPLATE_NAPI_REQUIRED",
			`Unsupported platform/arch '${key}' for @c9up/rover native binary. Supported: ${Object.keys(SUFFIX_MAP).join(", ")}.`,
			{
				hint: "Build the native binary on a supported platform with 'pnpm --filter @c9up/rover build:napi'.",
			},
		);
	}
	return suffix;
}

/** Opaque handle to a compiled template IR (Rust `RoverIr`). */
export type NativeRoverIr = import("../native/generated.js").RoverIr;

/**
 * The engine's surface, as the Rust declares it.
 *
 * Derived from `../native/generated.js` — written by `pnpm build:napi-types`
 * from napi-derive's own `type-def` output — rather than restated here, where
 * nothing would notice a `pub fn` gaining a parameter or changing its return.
 * The runtime guard below still checks the three exports are actually there:
 * a declaration says what the Rust promises, not what a stale binary shipped.
 */
type NativeExports = typeof import("../native/generated.js");

function isNativeExports(value: unknown): value is NativeExports {
	if (value === null || typeof value !== "object") return false;
	return (
		typeof Reflect.get(value, "engineVersion") === "function" &&
		typeof Reflect.get(value, "compile") === "function" &&
		typeof Reflect.get(value, "renderIr") === "function"
	);
}

let cachedNative: NativeExports | undefined;

export function getNative(): NativeExports {
	if (cachedNative !== undefined) return cachedNative;

	const require = createRequire(import.meta.url);
	const here = fileURLToPath(import.meta.url);
	// `here` is `…/packages/rover/src/templating/loadNapi.ts` (or `dist/…`). The
	// `.node` lives at the package root `…/packages/rover/index.<suffix>.node`,
	// two levels up from `src/templating` / `dist/templating`.
	const suffix = platformSuffix();
	const candidate = `../../index.${suffix}.node`;
	let loaded: unknown;
	let lastErr: unknown;
	try {
		loaded = require(candidate);
	} catch (err) {
		lastErr = err;
	}
	if (loaded === undefined) {
		const causeMessage =
			lastErr instanceof Error ? lastErr.message : String(lastErr);
		// The prebuilt linux binaries target glibc (`-gnu`). On musl hosts (Alpine
		// containers) the `-gnu` binary fails to dlopen with a libc symbol error —
		// surface that explicitly rather than only pointing at the build step.
		const muslHint = suffix.endsWith("-gnu")
			? " If you are on Alpine/musl, note the prebuilt binaries target glibc (musl is not a supported target)."
			: "";
		throw new RoverError(
			"MAIL_TEMPLATE_NAPI_REQUIRED",
			`@c9up/rover native binary 'index.${suffix}.node' not found or failed to load near ${here} — run 'pnpm --filter @c9up/rover build:napi' to build it.${muslHint} Cause: ${causeMessage}`,
			{
				hint: "Run 'pnpm --filter @c9up/rover build:napi' to compile the native template engine.",
			},
		);
	}
	if (!isNativeExports(loaded)) {
		throw new RoverError(
			"MAIL_TEMPLATE_NAPI_REQUIRED",
			"@c9up/rover native binary loaded but missing expected exports (engineVersion / compile / renderIr). Rebuild with 'pnpm --filter @c9up/rover build:napi'.",
			{
				hint: "The native binary is stale — rebuild with 'pnpm --filter @c9up/rover build:napi'.",
			},
		);
	}
	cachedNative = loaded;
	return cachedNative;
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
	MAIL_TEMPLATE_SYNTAX:
		"Check the template grammar: {{ var }}, {{{ raw }}}, {{#if x}}...{{/if}}, {{> partial}}.",
	MAIL_TEMPLATE_RECURSION:
		"Break the cycle — a template cannot include itself (directly or via partials).",
	MAIL_TEMPLATE_NOT_FOUND:
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
			"MAIL_TEMPLATE_SYNTAX",
			`Native template call failed: ${err.message}`,
		);
	}
	return new RoverError(
		"MAIL_TEMPLATE_SYNTAX",
		`Native template call failed with non-Error: ${String(err)}`,
	);
}
