import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RoverError } from "../../src/RoverError.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	render,
	renderFile,
	resetCache,
	setViewsRoot,
} from "../../src/templating/SimpleTemplate.js";

describe("rover > SimpleTemplate", () => {
	describe("render (string source)", () => {
		it("interpolates a simple variable", async () => {
			expect(await render("Hi {{ name }}", { name: "Ada" })).toBe("Hi Ada");
		});

		it("resolves dot-path identifiers", async () => {
			expect(
				await render("{{ user.email }}", { user: { email: "a@b.co" } }),
			).toBe("a@b.co");
		});

		it("HTML-escapes by default", async () => {
			expect(await render("{{ name }}", { name: "<script>" })).toBe(
				"&lt;script&gt;",
			);
			expect(await render("{{ name }}", { name: "A & B" })).toBe("A &amp; B");
			expect(await render("{{ name }}", { name: '"' })).toBe("&quot;");
		});

		it("triple-brace inserts raw (no escape)", async () => {
			expect(await render("{{{ html }}}", { html: "<b>hi</b>" })).toBe(
				"<b>hi</b>",
			);
		});

		it("missing value renders empty string, not 'undefined'", async () => {
			expect(await render("Hello {{ name }}!", {})).toBe("Hello !");
		});

		it("conditional renders body when truthy", async () => {
			expect(await render("{{#if show}}YES{{/if}}", { show: true })).toBe(
				"YES",
			);
		});

		it("conditional omits body when falsy", async () => {
			expect(await render("{{#if show}}YES{{/if}}", { show: false })).toBe("");
		});

		it("conditional treats missing key as falsy", async () => {
			expect(await render("{{#if missing}}NO{{/if}}", {})).toBe("");
		});

		it("unclosed {{#if}} throws MAIL_TEMPLATE_SYNTAX", async () => {
			await expect(
				render("{{#if foo}}nope", { foo: true }),
			).rejects.toMatchObject({
				code: "MAIL_TEMPLATE_SYNTAX",
			});
		});

		it("empty partial name throws MAIL_TEMPLATE_SYNTAX", async () => {
			await expect(render("{{> }}", {})).rejects.toMatchObject({
				code: "MAIL_TEMPLATE_SYNTAX",
			});
		});

		it("invalid dot-path (double-dot) throws MAIL_TEMPLATE_SYNTAX", async () => {
			await expect(render("{{ user..email }}", {})).rejects.toMatchObject({
				code: "MAIL_TEMPLATE_SYNTAX",
			});
		});
	});

	describe("renderFile (filesystem)", () => {
		let root: string;

		beforeEach(() => {
			root = mkdtempSync(path.join(tmpdir(), "rover-tmpl-"));
			setViewsRoot(root);
			resetCache();
		});

		afterEach(() => {
			rmSync(root, { recursive: true, force: true });
		});

		it("resolves paths under viewsRoot with .html extension", async () => {
			writeFileSync(path.join(root, "welcome.html"), "Hi {{ name }}");
			expect(await renderFile("welcome", { name: "Ada" })).toBe("Hi Ada");
		});

		it("renders partials via {{> name}}", async () => {
			writeFileSync(path.join(root, "welcome.html"), "Greet: {{> footer}}");
			mkdirSync(path.join(root, "partials"));
			writeFileSync(
				path.join(root, "partials", "footer.html"),
				"bye {{ name }}",
			);

			expect(await renderFile("welcome", { name: "Ada" })).toBe(
				"Greet: bye Ada",
			);
		});

		it("caches compiled templates (second render uses compiled IR, not disk)", async () => {
			const file = path.join(root, "welcome.html");
			writeFileSync(file, "v1 {{ name }}");
			expect(await renderFile("welcome", { name: "A" })).toBe("v1 A");

			// Overwrite the file on disk — a cache miss would pick this up;
			// a cache hit keeps using the compiled IR from the first read.
			writeFileSync(file, "v2 {{ name }}");
			expect(await renderFile("welcome", { name: "B" })).toBe("v1 B");

			// After reset, the new content is picked up.
			resetCache();
			expect(await renderFile("welcome", { name: "C" })).toBe("v2 C");
		});

		it("missing template throws MAIL_TEMPLATE_NOT_FOUND with path in context", async () => {
			await expect(renderFile("missing", {})).rejects.toMatchObject({
				code: "MAIL_TEMPLATE_NOT_FOUND",
				context: expect.objectContaining({
					path: expect.stringContaining("missing.html"),
				}),
			});
		});

		it("missing template error is a RoverError", async () => {
			await expect(renderFile("nope", {})).rejects.toBeInstanceOf(RoverError);
		});

		it("rejects absolute paths outside viewsRoot (path traversal guard)", async () => {
			await expect(renderFile("/etc/passwd", {})).rejects.toMatchObject({
				code: "MAIL_TEMPLATE_NOT_FOUND",
			});
		});

		it("rejects `../` traversal that escapes viewsRoot", async () => {
			await expect(renderFile("../../../etc/passwd", {})).rejects.toMatchObject(
				{
					code: "MAIL_TEMPLATE_NOT_FOUND",
				},
			);
		});

		it("allows safe names that stay under viewsRoot", async () => {
			writeFileSync(path.join(root, "welcome.html"), "hi");
			await expect(renderFile("welcome", {})).resolves.toBe("hi");
		});

		it("detects partial self-recursion and throws MAIL_TEMPLATE_RECURSION", async () => {
			mkdirSync(path.join(root, "partials"));
			writeFileSync(
				path.join(root, "partials", "loop.html"),
				"body {{> loop}}",
			);

			await expect(renderFile("partials/loop", {})).rejects.toMatchObject({
				code: "MAIL_TEMPLATE_RECURSION",
			});
		});

		it("detects mutual recursion (a → b → a)", async () => {
			mkdirSync(path.join(root, "partials"));
			writeFileSync(path.join(root, "partials", "a.html"), "A {{> b}}");
			writeFileSync(path.join(root, "partials", "b.html"), "B {{> a}}");

			await expect(renderFile("partials/a", {})).rejects.toMatchObject({
				code: "MAIL_TEMPLATE_RECURSION",
			});
		});

		it("throws MAIL_TEMPLATE_NOT_FOUND context carries tried paths", async () => {
			await expect(renderFile("missing", {})).rejects.toMatchObject({
				context: expect.objectContaining({
					paths: expect.stringContaining("missing.html"),
				}),
			});
		});
	});

	describe("safety", () => {
		it("dot-path resolver blocks __proto__ / constructor / prototype", async () => {
			const polluted = { name: "Ada" };
			expect(await render("{{ __proto__.x }}", polluted)).toBe("");
			expect(await render("{{ constructor.name }}", polluted)).toBe("");
			expect(await render("{{ name }}", polluted)).toBe("Ada");
		});

		it("dot-path resolver uses own properties only (ignores prototype chain)", async () => {
			const parent = { inherited: "from proto" };
			const child = Object.create(parent) as Record<string, unknown>;
			child.ownField = "own value";
			expect(await render("{{ ownField }}", child)).toBe("own value");
			expect(await render("{{ inherited }}", child)).toBe("");
		});

		it("escapeHtml also escapes `/` and backtick for defense-in-depth", async () => {
			expect(await render("{{ s }}", { s: "</script>" })).toBe(
				"&lt;&#x2F;script&gt;",
			);
			expect(await render("{{ s }}", { s: "`backtick`" })).toBe(
				"&#x60;backtick&#x60;",
			);
		});

		it("unclosed {{#if}} error message includes the opening line number", async () => {
			await expect(
				render("line1\nline2 {{#if foo}}nope", { foo: true }),
			).rejects.toMatchObject({
				code: "MAIL_TEMPLATE_SYNTAX",
				message: expect.stringMatching(/line 2/),
			});
		});
	});
});
