import { readFile } from "node:fs/promises";
import path from "node:path";
import { ReamError } from "@c9up/ream";
import { getNative, type NativeRoverIr, toReamError } from "./loadNapi.js";

// The compile + interpret hot path now runs in Rust via napi-rs
// (`rover-template-engine`). This TS facade keeps the byte-identical public
// surface — `render` / `renderFile` / `setViewsRoot` / `getViewsRoot` /
// `resetCache` — and owns everything that touches the filesystem: path
// resolution (incl. the `viewsRoot` traversal guard), the FS read, the
// compiled-IR cache, and the transitive partial pre-resolution (D55.2.1). The
// engine never reads disk (ADR-007). Render-time `{{> partial}}` recursion is
// detected Rust-side (D55.2.2) and surfaces here as `MAIL_TEMPLATE_RECURSION`.

let viewsRoot = "resources/views/emails";
// Resolved-absolute-path -> compiled Rust IR handle. Content-blind: an entry is
// reused verbatim until `resetCache()` (D55.2.3 — NO mtime/content invalidation;
// locked by `simple-template.test.ts:109-122`).
const cache = new Map<string, NativeRoverIr>();

export function setViewsRoot(rootDir: string): void {
	viewsRoot = rootDir;
}

export function getViewsRoot(): string {
	return viewsRoot;
}

/** Reset cached compiled templates (test helper). */
export function resetCache(): void {
	cache.clear();
}

export async function render(
	source: string,
	data: Record<string, unknown>,
): Promise<string> {
	const ir = compileSource(source);
	const partials = await buildPartialMap(ir);
	return renderNative(ir, data, partials);
}

export async function renderFile(
	viewPath: string,
	data: Record<string, unknown>,
	_visited: Set<string> = new Set(),
): Promise<string> {
	const ir = await loadIr(viewPath);
	const partials = await buildPartialMap(ir);
	return renderNative(ir, data, partials);
}

/** Compile inline source to an IR handle, mapping native errors to `ReamError`. */
function compileSource(source: string): NativeRoverIr {
	try {
		return getNative().compile(source);
	} catch (err) {
		throw toReamError(err);
	}
}

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

/**
 * JSON replacer reconciling JS values the pre-migration engine rendered via
 * `String(raw)` but that `JSON.stringify` drops or rejects at the NAPI boundary:
 *   - bigint: widen to Number when it round-trips exactly, else refuse (a raw
 *     `JSON.stringify` would throw a bare TypeError → opaque error).
 *   - NaN / ±Infinity: JSON encodes both as null, so they would render empty and
 *     Infinity would silently flip from truthy to falsy. Refuse loudly instead.
 * Note: a `Date` is serialised by its `toJSON` (ISO-8601), a deliberate change
 * from the old engine's locale `String(date)` — ISO is the stable mail format.
 */
function dataReplacer(_key: string, value: unknown): unknown {
	if (typeof value === "bigint") {
		if (value >= MIN_SAFE_BIGINT && value <= MAX_SAFE_BIGINT) {
			return Number(value);
		}
		throw new ReamError(
			"MAIL_TEMPLATE_SYNTAX",
			`Cannot render bigint ${value} — it exceeds Number.MAX_SAFE_INTEGER and cannot cross the template engine boundary without precision loss; format it to a string before rendering`,
		);
	}
	if (typeof value === "number" && !Number.isFinite(value)) {
		throw new ReamError(
			"MAIL_TEMPLATE_SYNTAX",
			`Cannot render non-finite number ${value} — NaN and Infinity have no representation across the template engine boundary; format it to a string before rendering`,
		);
	}
	return value;
}

/** Render a compiled IR, mapping native errors (syntax/recursion) to `ReamError`. */
function renderNative(
	ir: NativeRoverIr,
	data: Record<string, unknown>,
	partials: Record<string, NativeRoverIr>,
): string {
	try {
		// `data` crosses as a JSON string: `JSON.stringify` is own-enumerable-only,
		// preserving the engine's `Object.hasOwn` dot-path contract (inherited
		// prototype-chain props stay invisible — the own-property-only parity test).
		// `dataReplacer` reconciles bigint / NaN / Infinity (see above).
		return getNative().renderIr(
			ir,
			JSON.stringify(data, dataReplacer),
			partials,
		);
	} catch (err) {
		throw toReamError(err);
	}
}

/** Extract a Node `fs` errno string (e.g. `"ENOENT"`) without an `as` cast. */
function errnoCode(err: unknown): string {
	if (err !== null && typeof err === "object") {
		const code = Reflect.get(err, "code");
		if (typeof code === "string") return code;
	}
	return "";
}

/**
 * Resolve + read + compile one template path, caching the compiled IR by its
 * resolved absolute path. Owns the `MAIL_TEMPLATE_NOT_FOUND` / `_READ_ERROR`
 * raising (unchanged from the pre-migration engine).
 */
async function loadIr(viewPath: string): Promise<NativeRoverIr> {
	const { resolved, tried } = resolveTemplatePath(viewPath);
	const cached = cache.get(resolved);
	if (cached !== undefined) return cached;

	let source: string;
	try {
		source = await readFile(resolved, "utf8");
	} catch (err) {
		const code = errnoCode(err);
		// Only ENOENT maps to NOT_FOUND; permission/io errors surface distinctly.
		if (code !== "ENOENT") {
			throw new ReamError(
				"MAIL_TEMPLATE_READ_ERROR",
				`Template read failed at ${resolved} (${code || "unknown"})`,
				{
					hint: "Check filesystem permissions and file descriptor limits.",
					context: { path: resolved, code, viewsRoot },
				},
			);
		}
		throw new ReamError(
			"MAIL_TEMPLATE_NOT_FOUND",
			`Template not found at ${resolved}`,
			{
				hint: "Create the file or update config.mail.viewsRoot.",
				context: {
					path: resolved,
					paths: tried.join(", "),
					viewsRoot,
				},
			},
		);
	}

	const ir = compileSource(source);
	cache.set(resolved, ir);
	return ir;
}

/**
 * Transitively pre-resolve every `{{> name}}` partial reachable from `rootIr`
 * into a `name -> IR handle` map (D55.2.1). Stops re-descending once a name is
 * mapped, so a cyclic partial graph terminates here WITHOUT erroring — the
 * actual `MAIL_TEMPLATE_RECURSION` is raised Rust-side only when the cycle is
 * really rendered (D55.2.2). Partials read here are cached by resolved path
 * (content-blind), exactly as the pre-migration recursive `renderFile` did.
 */
async function buildPartialMap(
	rootIr: NativeRoverIr,
): Promise<Record<string, NativeRoverIr>> {
	const map: Record<string, NativeRoverIr> = {};
	const stack: NativeRoverIr[] = [rootIr];
	while (stack.length > 0) {
		const ir = stack.pop();
		if (ir === undefined) break;
		for (const name of ir.partialNames) {
			if (Object.hasOwn(map, name)) continue;
			let partialIr: NativeRoverIr;
			try {
				partialIr = await loadIr(`partials/${name}`);
			} catch (err) {
				// A partial referenced only inside a falsy `{{#if}}` is never
				// rendered. The pre-migration engine loaded partials lazily, so a
				// missing such partial did not error. Skip it here; if it IS reached
				// at render time the Rust renderer raises MAIL_TEMPLATE_NOT_FOUND.
				if (
					err instanceof ReamError &&
					err.code === "MAIL_TEMPLATE_NOT_FOUND"
				) {
					continue;
				}
				throw err;
			}
			map[name] = partialIr;
			stack.push(partialIr);
		}
	}
	return map;
}

/**
 * Resolve a template path under `viewsRoot`, rejecting any attempt to escape
 * the root (absolute path outside, or `../` traversal after normalisation).
 * Returns the resolved absolute path plus the set of candidates tried.
 */
function resolveTemplatePath(viewPath: string): {
	resolved: string;
	tried: string[];
} {
	const rootAbs = path.resolve(viewsRoot);
	const startingPoint = path.isAbsolute(viewPath)
		? viewPath
		: path.resolve(rootAbs, viewPath);
	const withoutExt = startingPoint;
	const withExt = startingPoint.endsWith(".html")
		? startingPoint
		: `${startingPoint}.html`;
	const candidate = path.resolve(withExt);
	const rel = path.relative(rootAbs, candidate);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new ReamError(
			"MAIL_TEMPLATE_NOT_FOUND",
			`Template path "${viewPath}" resolves outside of viewsRoot`,
			{
				hint: "Template names must stay under viewsRoot. Absolute paths and `..` traversals are rejected.",
				context: { path: candidate, viewsRoot: rootAbs },
			},
		);
	}
	return { resolved: candidate, tried: [withExt, withoutExt] };
}
