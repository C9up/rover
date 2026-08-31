/**
 * The message inspection surface — `hasX` / `assertX`.
 *
 * This is the API a consumer writes THEIR tests with, through `mail.fake()`.
 * An assertion that never throws is worse than no assertion: it turns a green
 * suite into a claim nobody checked. So each one is exercised both ways, on a
 * message that matches and on one that does not.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessageBuilder } from "../../src/index.js";
import {
	resetCache,
	setViewsRoot,
} from "../../src/templating/SimpleTemplate.js";

/** A message with one of everything the assertions can look at. */
const filled = () =>
	new MessageBuilder()
		.from("ada@acme.test", "Ada Lovelace")
		.to("grace@acme.test", "Grace Hopper")
		.cc("cc@acme.test")
		.bcc("bcc@acme.test")
		.replyTo("reply@acme.test")
		.subject("Quarterly report")
		.html("<p>The report is attached.</p>")
		.text("The report is attached.")
		.header("X-Campaign", "q3")
		.attachData(Buffer.from("%PDF"), { filename: "report.pdf" });

describe("rover > the assertions pass on a match", () => {
	it("accepts every field it was given", () => {
		const m = filled();

		expect(() => {
			m.assertFrom("ada@acme.test");
			m.assertTo("grace@acme.test");
			m.assertCc("cc@acme.test");
			m.assertBcc("bcc@acme.test");
			m.assertReplyTo("reply@acme.test");
			m.assertSubject("Quarterly report");
			m.assertRecipient("cc@acme.test");
			m.assertContent("report is attached");
			m.assertHeader("X-Campaign");
			m.assertHeader("X-Campaign", "q3");
			m.assertAttachment("report.pdf");
			m.assertAttachment((a) => a.filename.endsWith(".pdf"));
			m.assertHtmlIncludes("<p>");
			m.assertTextIncludes("attached");
		}).not.toThrow();
	});
});

describe("rover > the assertions throw on a mismatch", () => {
	// Each case names the field, so a failing consumer test says which one.
	const cases: Array<[string, (m: MessageBuilder) => void, RegExp]> = [
		["from", (m) => m.assertFrom("someone@else.test"), /from to be/],
		["to", (m) => m.assertTo("someone@else.test"), /to include/],
		["cc", (m) => m.assertCc("someone@else.test"), /cc to include/],
		["bcc", (m) => m.assertBcc("someone@else.test"), /bcc to include/],
		["replyTo", (m) => m.assertReplyTo("someone@else.test"), /replyTo to be/],
		["subject", (m) => m.assertSubject("Something else"), /subject to be/],
		["recipient", (m) => m.assertRecipient("someone@else.test"), /to reach/],
		["content", (m) => m.assertContent("nowhere in the body"), /to contain/],
		["header name", (m) => m.assertHeader("X-Missing"), /X-Missing/],
		["header value", (m) => m.assertHeader("X-Campaign", "q4"), /q4/],
		[
			"attachment by name",
			(m) => m.assertAttachment("missing.pdf"),
			/missing\.pdf/,
		],
		[
			"attachment by predicate",
			(m) => m.assertAttachment(() => false),
			/predicate/,
		],
		["html", (m) => m.assertHtmlIncludes("not in the html"), /html to include/],
		["text", (m) => m.assertTextIncludes("not in the text"), /text to include/],
	];

	for (const [name, run, expected] of cases) {
		it(`says so on ${name}`, () => {
			expect(() => run(filled())).toThrow(expected);
		});
	}

	it("reports what the message actually held, not just that it failed", () => {
		// A failure that does not show the actual value sends the reader back to
		// the code to find out what was there.
		expect(() => filled().assertSubject("Something else")).toThrow(
			/Quarterly report/,
		);
	});
});

describe("rover > the questions the assertions are built on", () => {
	it("answers the bare form as 'is anything set'", () => {
		expect(filled().hasSubject()).toBe(true);
		expect(filled().hasAttachment()).toBe(true);
		expect(new MessageBuilder().hasSubject()).toBe(false);
		expect(new MessageBuilder().hasAttachment()).toBe(false);
	});

	it("matches a recipient by display name as well as by address", () => {
		expect(filled().hasTo("grace@acme.test", "Grace Hopper")).toBe(true);
		expect(filled().hasTo("grace@acme.test", "Someone Else")).toBe(false);
		expect(filled().hasFrom("ada@acme.test", "Ada Lovelace")).toBe(true);
	});

	it("finds an attachment by its source path, including as a URL", () => {
		// Both sides go through the platform's own path form. Written with a
		// POSIX literal and `file:///tmp/...`, this passed everywhere except
		// Windows, where fileURLToPath answers `\tmp\invoice.pdf` and no
		// comparison against `/tmp/invoice.pdf` can succeed.
		const invoice = path.resolve(tmpdir(), "invoice.pdf");
		const m = new MessageBuilder().attach(invoice);

		expect(m.hasAttachment(invoice)).toBe(true);
		expect(m.hasAttachment(pathToFileURL(invoice))).toBe(true);
		expect(m.hasAttachment(path.resolve(tmpdir(), "other.pdf"))).toBe(false);
	});

	it("answers false for a header, or a list header, that was never set", () => {
		expect(filled().hasHeader("X-Missing")).toBe(false);
		expect(filled().hasListHeader("unsubscribe")).toBe(false);
	});

	it("matches one value out of a multi-valued header", () => {
		const m = new MessageBuilder().header("X-Tag", ["a", "b"]);

		expect(m.hasHeader("X-Tag", "b")).toBe(true);
		expect(m.hasHeader("X-Tag", "c")).toBe(false);
	});

	it("matches one URL out of a list header, whatever form it was written in", () => {
		const m = new MessageBuilder().addListHeader("unsubscribe", [
			"https://acme.test/unsub",
			{ url: "mailto:unsub@acme.test", comment: "or write to us" },
		]);

		expect(m.hasListHeader("unsubscribe")).toBe(true);
		expect(m.hasListHeader("unsubscribe", "https://acme.test/unsub")).toBe(
			true,
		);
		expect(m.hasListHeader("unsubscribe", "mailto:unsub@acme.test")).toBe(true);
		expect(m.hasListHeader("unsubscribe", "https://elsewhere.test")).toBe(
			false,
		);
	});
});

describe("rover > the header fields that only appear at build()", () => {
	it("carries priority, message id and the threading headers", async () => {
		const built = await new MessageBuilder()
			.from("a@b.co")
			.to("c@d.co")
			.priority("high")
			.messageId("<first@acme.test>")
			.inReplyTo("<parent@acme.test>")
			.references(["<root@acme.test>", "<parent@acme.test>"])
			.build();

		expect(built.priority).toBe("high");
		expect(built.messageId).toBe("<first@acme.test>");
		expect(built.inReplyTo).toBe("<parent@acme.test>");
		expect(built.references).toEqual([
			"<root@acme.test>",
			"<parent@acme.test>",
		]);
	});

	it("copies the references list, so a later push cannot reach the message", async () => {
		const refs = ["<root@acme.test>"];
		const built = await new MessageBuilder().references(refs).build();
		refs.push("<injected@evil.test>");

		expect(built.references).toEqual(["<root@acme.test>"]);
	});

	it("embeds bytes under a cid, inline by default", async () => {
		const built = await new MessageBuilder()
			.embedData(Buffer.from("PNG"), "logo")
			.build();

		expect(built.attachments[0]).toMatchObject({
			filename: "logo",
			cid: "logo",
			contentDisposition: "inline",
		});
	});

	it("takes a filename and a type for an embed", async () => {
		const built = await new MessageBuilder()
			.embedData(Buffer.from("PNG"), "logo", {
				filename: "logo.png",
				contentType: "image/png",
			})
			.build();

		expect(built.attachments[0]).toMatchObject({
			filename: "logo.png",
			contentType: "image/png",
			cid: "logo",
		});
	});
});

describe("rover > recipients given as a list", () => {
	it("takes an array of addresses, and of name/address pairs", async () => {
		const built = await new MessageBuilder()
			.to([
				"plain@acme.test",
				{ address: "named@acme.test", name: "Named Person" },
			])
			.cc(["cc1@acme.test", "cc2@acme.test"])
			.build();

		expect(built.to).toEqual([
			"plain@acme.test",
			'"Named Person" <named@acme.test>',
		]);
		expect(built.cc).toEqual(["cc1@acme.test", "cc2@acme.test"]);
	});
});

describe("rover > the plain-text view", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "rover-textview-"));
		setViewsRoot(root);
		resetCache();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("renders into the text body, and records the template it came from", async () => {
		writeFileSync(path.join(root, "receipt.html"), "Thanks, {{ name }}.");

		const builder = new MessageBuilder().textView("receipt", {
			name: "Ada",
		});
		const built = await builder.build();

		expect(built.text).toBe("Thanks, Ada.");
		// The rendered-template record is what the lifecycle events carry.
		expect(builder.contentViews.text).toEqual({
			template: "receipt",
			data: { name: "Ada" },
		});
	});

	it("renders the text view once, not again on a second build", async () => {
		writeFileSync(path.join(root, "receipt.html"), "Thanks.");
		const builder = new MessageBuilder().textView("receipt");

		await builder.build();
		rmSync(path.join(root, "receipt.html"));

		// The second build must not go back to a file that is no longer there.
		expect((await builder.build()).text).toBe("Thanks.");
	});
});
