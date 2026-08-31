import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RoverError } from "../../src/RoverError.js";
import {
	render,
	resetCache,
	setViewsRoot,
} from "../../src/templating/SimpleTemplate.js";

// Parity guards for JS values the pre-migration engine rendered via String(raw)
// but that the JSON/NAPI boundary drops, rejects, or reshapes.

describe("marshalling — bigint", () => {
	it("renders a safe-range bigint like the old String(value)", async () => {
		expect(await render("{{ n }}", { n: 42n })).toBe("42");
		expect(
			await render("{{ n }}", { n: BigInt(Number.MAX_SAFE_INTEGER) }),
		).toBe(String(Number.MAX_SAFE_INTEGER));
	});

	it("rejects a bigint beyond MAX_SAFE_INTEGER instead of throwing a bare TypeError", async () => {
		await expect(render("{{ n }}", { n: 2n ** 60n })).rejects.toMatchObject({
			code: "E_MAIL_TEMPLATE_SYNTAX",
		});
	});
});

describe("marshalling — non-finite numbers", () => {
	it("rejects NaN rather than rendering empty", async () => {
		await expect(render("{{ x }}", { x: Number.NaN })).rejects.toBeInstanceOf(
			RoverError,
		);
	});

	it("rejects Infinity rather than silently flipping truthy→falsy", async () => {
		await expect(
			render("{{#if x}}Y{{/if}}", { x: Number.POSITIVE_INFINITY }),
		).rejects.toMatchObject({ code: "E_MAIL_TEMPLATE_SYNTAX" });
	});
});

describe("marshalling — Date renders as ISO-8601 (documented divergence)", () => {
	it("uses toJSON, not the locale string", async () => {
		const d = new Date(0);
		expect(await render("{{ d }}", { d })).toBe("1970-01-01T00:00:00.000Z");
	});
});

describe("buildPartialMap — laziness for partials behind a falsy if", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "rover-parity-"));
		setViewsRoot(root);
		resetCache();
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("does not eagerly fail when a missing partial sits inside a falsy {{#if}}", async () => {
		// The partial file does not exist; the old engine never loaded it because
		// the branch is falsy. The port must not raise E_MAIL_TEMPLATE_NOT_FOUND.
		expect(
			await render("{{#if show}}{{> missing}}{{/if}}done", { show: false }),
		).toBe("done");
	});
});

describe("resolve — arr.length parity (R4)", () => {
	it("resolves arr.length to the element count, like the pre-migration engine", async () => {
		expect(await render("{{ items.length }}", { items: [1, 2, 3] })).toBe("3");
		expect(await render("{{ items.length }}", { items: [] })).toBe("0");
		expect(await render("{{#if items.length}}yes{{/if}}", { items: [1] })).toBe(
			"yes",
		);
	});
});

describe("engine — deep nesting is a catchable error, not a process abort", () => {
	it("rejects {{#if}} nested beyond the depth limit", async () => {
		const depth = 600;
		const src = `${"{{#if a}}".repeat(depth)}x${"{{/if}}".repeat(depth)}`;
		await expect(render(src, { a: true })).rejects.toBeInstanceOf(RoverError);
	});
});
