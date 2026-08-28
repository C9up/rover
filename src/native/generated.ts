// GENERATED FROM THE RUST — do not edit.
//
// Produced by scripts/generate-napi-types.mjs from napi-derive's type-def
// output. Editing this file by hand puts it back where it started: a
// description that can disagree with the code it describes.

/**
 * Opaque handle to a compiled template IR. The TS-side `cache` keeps these
 * instances alive; when the JS GC collects the wrapper, napi-rs drops the
 * inner `Arc` automatically (Arc + GC bridge — no manual dispose API).
 */

export declare class RoverIr {
	/**
	 * Every referenced partial name, in document order (descends into
	 * `{{#if}}` bodies). Drives the TS facade's transitive partial map build.
	 */
	get partialNames(): Array<string>;
}

/** Compile a template source string into an opaque `RoverIr` handle. */

export declare function compile(source: string): RoverIr;

/**
 * Render a compiled IR against `data` (a JSON string), resolving `{{> name}}`
 * partials from the pre-resolved `partials` map. Render-time recursion ->
 * `MAIL_TEMPLATE_RECURSION`.
 *
 * `data` crosses as a JSON STRING (the TS facade calls `JSON.stringify`), not
 * as an object graph: `JSON.stringify` is own-enumerable-only, which preserves
 * the engine's `Object.hasOwn` dot-path contract (inherited prototype-chain
 * props must NOT be visible — `simple-template.test.ts:195-201`). It is also a
 * single native stringify + one Rust parse, instead of napi walking the whole
 * object graph (which would additionally surface inherited enumerable props).
 */

export declare function renderIr(
	ir: RoverIr,
	dataJson: string,
	partials: Record<string, RoverIr>,
): string;

/** Crate version — useful for the TS-side `loadNapi.ts` startup diagnostic. */

export declare function engineVersion(): string;
