/**
 * The `@adonisjs/mail` message surface rover was missing: file-based
 * attachments and embeds, RFC 2369 `List-*` headers, calendar invitations, and
 * the generic inspection forms.
 *
 * rover had swapped Adonis's path-based `attach(file)` for a content-based
 * `attach(filename, content)` under a "no-fs" rationale it does not have — it
 * already reads templates with `node:fs`. A migrated app calling
 * `attach('/tmp/invoice.pdf')` therefore attached a file named after the path
 * with an empty body.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
	attachmentsFor,
	headerValue,
	MessageBuilder,
} from "../../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "rover-msg-"));
const invoice = join(dir, "invoice.pdf");
const ics = join(dir, "meeting.ics");
writeFileSync(invoice, "%PDF-1.4 fake");
writeFileSync(ics, "BEGIN:VCALENDAR\nEND:VCALENDAR");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function message(): MessageBuilder {
	return new MessageBuilder().from("a@b.co").to("c@d.co").subject("Hi");
}

describe("rover > attachments by path", () => {
	it("reads the file at build() and names it from the path", async () => {
		const built = await message().attach(invoice).build();

		expect(built.attachments).toHaveLength(1);
		expect(built.attachments[0].filename).toBe("invoice.pdf");
		expect(built.attachments[0].content.toString()).toBe("%PDF-1.4 fake");
	});

	it("accepts a file:// URL", async () => {
		const built = await message().attach(pathToFileURL(invoice)).build();

		expect(built.attachments[0].filename).toBe("invoice.pdf");
	});

	it("honours an explicit filename and content type", async () => {
		const built = await message()
			.attach(invoice, {
				filename: "facture.pdf",
				contentType: "application/pdf",
			})
			.build();

		expect(built.attachments[0].filename).toBe("facture.pdf");
		expect(built.attachments[0].contentType).toBe("application/pdf");
	});

	it("raises rather than ship an empty part when the file cannot be read", async () => {
		// The failure mode worth refusing: a recipient gets a 0-byte invoice.
		await expect(
			message().attach(join(dir, "missing.pdf")).build(),
		).rejects.toThrow(/Could not read/);
	});

	it("still takes bytes directly through attachData", async () => {
		const built = await message()
			.attachData("hello", { filename: "note.txt", contentType: "text/plain" })
			.build();

		expect(built.attachments[0].content).toBe("hello");
	});

	it("embeds a file inline under a cid", async () => {
		const built = await message().embed(invoice, "logo").build();

		expect(built.attachments[0].cid).toBe("logo");
		expect(built.attachments[0].contentDisposition).toBe("inline");
		expect(built.attachments[0].content.toString()).toBe("%PDF-1.4 fake");
	});

	it("finds an attachment by filename, by path, or by predicate", () => {
		const m = message().attach(invoice);

		expect(m.hasAttachment("invoice.pdf")).toBe(true);
		expect(m.hasAttachment(invoice)).toBe(true);
		expect(m.hasAttachment(pathToFileURL(invoice))).toBe(true);
		expect(m.hasAttachment((a) => a.filename.endsWith(".pdf"))).toBe(true);
		expect(m.hasAttachment("nope.pdf")).toBe(false);
	});
});

describe("rover > List-* headers", () => {
	it("renders a bare URL in angle brackets", async () => {
		const built = await message().listUnsubscribe("https://x.co/unsub").build();

		expect(built.headers["List-Unsubscribe"]).toBe("<https://x.co/unsub>");
	});

	it("renders several values, comments included", async () => {
		const built = await message()
			.listHelp([
				"https://x.co/help",
				{ url: "mailto:help@x.co", comment: "Email us" },
			])
			.build();

		expect(built.headers["List-Help"]).toBe(
			"<https://x.co/help>, <mailto:help@x.co> (Email us)",
		);
	});

	it("adds the RFC 8058 one-click header as a RAW header", async () => {
		// It must NOT go through the list map: nodemailer wraps every list value
		// in angle brackets, and `<List-Unsubscribe=One-Click>` is ignored.
		const built = await message()
			.listUnsubscribe("https://x.co/unsub", { oneClick: true })
			.build();

		expect(built.headers["List-Unsubscribe-Post"]).toBe(
			"List-Unsubscribe=One-Click",
		);
		expect(built.headers["List-Unsubscribe"]).toBe("<https://x.co/unsub>");
	});

	it("refuses one-click on a mailto:, which cannot answer a POST", () => {
		expect(() =>
			message().listUnsubscribe("mailto:unsub@x.co", { oneClick: true }),
		).toThrow(/answer a POST/);
	});

	it("replaces the value when the same key is set twice", async () => {
		const built = await message()
			.listSubscribe("https://x.co/one")
			.listSubscribe("https://x.co/two")
			.build();

		expect(built.headers["List-Subscribe"]).toBe("<https://x.co/two>");
	});

	it("titlecases a compound key", async () => {
		const built = await message()
			.addListHeader("post-only", "https://x.co/p")
			.build();

		expect(built.headers["List-Post-Only"]).toBe("<https://x.co/p>");
	});
});

describe("rover > calendar invitations", () => {
	it("carries inline ICS content", async () => {
		const built = await message()
			.icalEvent("BEGIN:VCALENDAR\nEND:VCALENDAR", { method: "REQUEST" })
			.build();

		expect(built.icalEvent?.content).toContain("VCALENDAR");
		expect(built.icalEvent?.method).toBe("REQUEST");
	});

	it("reads ICS from a file at build()", async () => {
		const built = await message().icalEventFromFile(ics).build();

		expect(built.icalEvent?.content).toContain("VCALENDAR");
	});

	it("becomes a text/calendar part for a transport with no calendar field", async () => {
		const built = await message()
			.icalEvent("BEGIN:VCALENDAR\nEND:VCALENDAR", { method: "REQUEST" })
			.build();

		const parts = attachmentsFor(built);

		expect(parts).toHaveLength(1);
		expect(parts[0].filename).toBe("invite.ics");
		expect(parts[0].contentType).toBe(
			"text/calendar; charset=utf-8; method=REQUEST",
		);
	});

	it("says so rather than drop an href-only invitation on an HTTP provider", async () => {
		const built = await message()
			.icalEventFromUrl("https://x.co/e.ics")
			.build();

		expect(() => attachmentsFor(built)).toThrow(/only supported by the SMTP/);
	});

	it("leaves the attachment list alone when there is no invitation", async () => {
		const built = await message()
			.attachData("x", { filename: "a.txt" })
			.build();

		expect(attachmentsFor(built)).toBe(built.attachments);
	});
});

describe("rover > generic inspection", () => {
	it("answers on any recipient field", () => {
		const m = message().cc("e@f.co").bcc("g@h.co");

		// `hasRecipient` now takes the field first, as AdonisJS does; the
		// any-field question moved to `hasAnyRecipient`, which is what this
		// test was always asking.
		expect(m.hasAnyRecipient("c@d.co")).toBe(true);
		expect(m.hasAnyRecipient("e@f.co")).toBe(true);
		expect(m.hasAnyRecipient("g@h.co")).toBe(true);
		expect(m.hasAnyRecipient("nobody@x.co")).toBe(false);
		expect(() => m.assertRecipient("nobody@x.co")).toThrow();
	});

	it("answers on one named field, as AdonisJS does", () => {
		const m = message().cc("e@f.co").bcc("g@h.co");

		expect(m.hasRecipient("cc", "e@f.co")).toBe(true);
		expect(m.hasRecipient("bcc", "g@h.co")).toBe(true);
		// The distinction the old signature could not express.
		expect(m.hasRecipient("to", "e@f.co")).toBe(false);
	});

	it("looks for content in either body", () => {
		const m = message().html("<p>Order 42</p>").text("Order 42 plain");

		expect(m.hasContent("Order 42")).toBe(true);
		expect(m.hasContent("Order 43")).toBe(false);
		expect(() => m.assertContent("Order 42")).not.toThrow();
		expect(() => m.assertContent("Order 43")).toThrow();
	});

	it("sets the body transfer encoding", async () => {
		const built = await message().encoding("base64").build();

		expect(built.encoding).toBe("base64");
	});
});

describe("rover > watch body and prepared headers", () => {
	it("writes the field nodemailer actually reads", async () => {
		const built = await message().watch("<p>on the wrist</p>").build();

		// AdonisJS writes a bare `watch` field, which nodemailer's mail composer
		// never reads (lib/mail-composer/index.js only looks at `watchHtml`), so
		// upstream's watch body never reaches the wire.
		expect(built.watchHtml).toBe("<p>on the wrist</p>");
	});

	it("watchHtml() is the same method under the field's own name", async () => {
		const built = await message().watchHtml("<p>x</p>").build();
		expect(built.watchHtml).toBe("<p>x</p>");
	});

	it("marks a prepared header so it is not re-encoded", async () => {
		const built = await message()
			.header("X-Plain", "value")
			.preparedHeader("X-Signature", "a=b; c=d")
			.build();

		expect(built.headers["X-Plain"]).toBe("value");
		expect(built.headers["X-Signature"]).toEqual({
			prepared: true,
			value: "a=b; c=d",
		});
	});

	it("flattens a prepared header for the HTTP-API transports", () => {
		// "Prepared" is a nodemailer notion: a provider REST API takes a JSON
		// string and does no MIME encoding, so sending the wrapper object would
		// put `[object Object]` on the wire.
		expect(headerValue({ prepared: true, value: "a=b" })).toBe("a=b");
		expect(headerValue("plain")).toBe("plain");
		expect(headerValue(["a", "b"])).toEqual(["a", "b"]);
	});
});

describe("rover > watchView and the AdonisJS accessor names", () => {
	it("renders a template into the watch body", async () => {
		const root = mkdtempSync(join(tmpdir(), "rover-watch-"));
		writeFileSync(join(root, "wrist.html"), "<p>{{ name }}</p>");

		const m = message().watchView("wrist", { name: "Ada" });
		const built = await m.build(root);

		expect(built.watchHtml).toBe("<p>Ada</p>");
		// The templates are reported alongside html and text.
		expect(m.views.watch).toEqual({ template: "wrist", data: { name: "Ada" } });
		rmSync(root, { recursive: true, force: true });
	});

	it("contentViews is the upstream name for views", async () => {
		const m = message().html("<p>x</p>");
		await m.build();
		expect(m.contentViews).toEqual(m.views);
	});

	it("nodeMailerMessage is the object the transports read", async () => {
		const m = message().subject("Hi");
		const built = await m.build();
		expect(m.nodeMailerMessage).toBe(built);
	});
});

describe("rover > assertWatchIncludes (AdonisJS parity)", () => {
	it("passes when the watch body contains the text", async () => {
		const m = message().watch("<p>on the wrist</p>");
		await m.build();

		expect(() => m.assertWatchIncludes("wrist")).not.toThrow();
		expect(() => m.assertWatchIncludes(/WRIST/i)).not.toThrow();
	});

	it("throws when it does not", async () => {
		const m = message().watch("<p>x</p>");
		await m.build();
		expect(() => m.assertWatchIncludes("missing")).toThrow();
	});
});
