/**
 * The @adonisjs/mail surface a migrated app touches beyond `mail.send()`: a
 * mail class that dispatches itself, message inspection inside a test
 * assertion, and the close pair a shutdown hook calls.
 */
import { describe, expect, it, vi } from "vitest";
import { BaseMail } from "../../src/BaseMail.js";
// From the package ENTRY, as a consumer does — that is what loads each
// transport module and lets it register itself.
import { transports } from "../../src/index.js";
import { Mail, registerTransport } from "../../src/Mail.js";
import { MessageBuilder } from "../../src/MessageBuilder.js";

class WelcomeMail extends BaseMail {
	from = "noreply@acme.test";
	subject = "Welcome!";
	constructor(readonly email: string) {
		super();
	}
	prepare(): void {
		this.message.to(this.email).html("<p>Hello there</p>").text("Hello there");
	}
}

const mailer = (): Mail =>
	new Mail({
		default: "log",
		from: "noreply@acme.test",
		mailers: { log: transports.log() },
	});

describe("rover > BaseMail dispatch", () => {
	it("sends itself through a mailer", async () => {
		const mail = mailer();
		const fake = mail.fake();
		await new WelcomeMail("ada@acme.test").send(mail);
		fake.assertSent(WelcomeMail);
		mail.restore();
	});

	it("queues itself through a mailer", async () => {
		const mail = mailer();
		const fake = mail.fake();
		await new WelcomeMail("ada@acme.test").sendLater(mail);
		fake.assertQueued(WelcomeMail);
		mail.restore();
	});

	it("exposes the message so a test can read it from outside", async () => {
		const mail = new WelcomeMail("ada@acme.test");
		await mail.build();
		expect(mail.message.hasTo("ada@acme.test")).toBe(true);
		expect(mail.message.hasSubject("Welcome!")).toBe(true);
	});

	it("renders contents ahead of time for inspection", async () => {
		const mail = new WelcomeMail("ada@acme.test");
		await mail.buildWithContents();
		mail.message.assertHtmlIncludes("Hello there");
	});
});

describe("rover > message inspection", () => {
	const built = (): MessageBuilder =>
		new MessageBuilder()
			.from("noreply@acme.test", "Acme")
			.to("ada@acme.test")
			.cc("cc@acme.test")
			.subject("Hi")
			.html("<b>body</b>")
			.text("body")
			.header("X-Campaign", "spring");

	it("matches a bare address inside its display form", () => {
		expect(built().hasFrom("noreply@acme.test")).toBe(true);
	});

	it("answers questions about what is set", () => {
		const m = built();
		expect(m.hasTo("ada@acme.test")).toBe(true);
		expect(m.hasTo("nobody@acme.test")).toBe(false);
		expect(m.hasCc()).toBe(true);
		expect(m.hasBcc()).toBe(false);
		expect(m.hasHeader("X-Campaign", "spring")).toBe(true);
		expect(m.hasHeader("X-Campaign", "autumn")).toBe(false);
	});

	it("asserts, and says what it got when it fails", () => {
		const m = built();
		expect(() => m.assertTo("ada@acme.test")).not.toThrow();
		expect(() => m.assertSubject("Hi")).not.toThrow();
		expect(() => m.assertTo("nobody@acme.test")).toThrow(
			/Expected the message to include "nobody@acme.test", got/,
		);
	});

	it("asserts on rendered content", () => {
		const m = built();
		expect(() => m.assertHtmlIncludes("body")).not.toThrow();
		expect(() => m.assertTextIncludes("body")).not.toThrow();
		expect(() => m.assertHtmlIncludes("missing")).toThrow();
	});

	it("hands the whole message back for anything else", () => {
		expect(built().toObject().subject).toBe("Hi");
		expect(built().toJSON().to).toEqual(["ada@acme.test"]);
	});
});

describe("rover > close", () => {
	it("closes a transport that holds connections open", async () => {
		const close = vi.fn(async () => {});
		registerTransport("closable", () => ({
			send: async () => ({ messageId: "1", accepted: [], rejected: [] }),
			close,
		}));
		const mail = new Mail({
			default: "closable",
			from: "noreply@acme.test",
			mailers: { closable: { transport: "closable" } },
		});
		await mail.closeAll();
		expect(close).toHaveBeenCalled();
	});

	it("does not throw on a name it does not know", async () => {
		await expect(mailer().close("absent")).resolves.toBeUndefined();
	});
});

describe("rover > transports are registered on import", () => {
	it("accepts every bundled transport by name from a config", () => {
		// Each transport module self-registers when loaded. Nothing imported
		// them, so a config naming `ses` failed at boot with "unknown transport".
		for (const name of [
			"smtp",
			"log",
			"ses",
			"mailgun",
			"sparkpost",
			"resend",
			"brevo",
			"sendgrid",
		]) {
			expect(() => transports[name as keyof typeof transports]).not.toThrow();
		}
		// It resolves the factory — a missing credential is the transport's own
		// complaint, which only a REGISTERED transport can make.
		expect(
			() =>
				new Mail({
					default: "ses",
					from: "noreply@acme.test",
					mailers: {
						ses: {
							transport: "ses",
							region: "us-east-1",
							accessKeyId: "k",
							secretAccessKey: "s",
						},
					},
				}),
		).not.toThrow();
	});
});

describe("rover > message body and envelope", () => {
	it("keeps a plain-text alternative beside the HTML", async () => {
		const message = await new MessageBuilder()
			.from("a@b.test")
			.to("c@d.test")
			.subject("Hi")
			.html("<b>hello</b>")
			.text("hello")
			.build();
		expect(message.html).toBe("<b>hello</b>");
		expect(message.text).toBe("hello");
	});

	it("carries an SMTP envelope distinct from the visible headers", async () => {
		const message = await new MessageBuilder()
			.from("newsletter@acme.test", "Acme")
			.to("reader@example.test")
			.envelope({ from: "bounces+reader@acme.test" })
			.build();
		// The bounce address is not the author the reader sees.
		expect(message.envelope?.from).toBe("bounces+reader@acme.test");
		expect(message.from).toContain("newsletter@acme.test");
	});
});

describe("rover > hasRecipient takes the field first (AdonisJS shape)", () => {
	function built() {
		const m = new MessageBuilder();
		m.to("ada@acme.test", "Ada").cc("cc@acme.test").replyTo("reply@acme.test");
		return m;
	}

	it("checks one named field", () => {
		const m = built();
		expect(m.hasRecipient("to", "ada@acme.test")).toBe(true);
		expect(m.hasRecipient("cc", "cc@acme.test")).toBe(true);
		expect(m.hasRecipient("replyTo", "reply@acme.test")).toBe(true);
	});

	it("does not find an address in a field it is not in", () => {
		// It used to take the address alone and search every field, so
		// `hasRecipient('to', addr)` asked whether "to" was a recipient and
		// quietly answered false.
		const m = built();
		expect(m.hasRecipient("bcc", "ada@acme.test")).toBe(false);
		expect(m.hasRecipient("cc", "ada@acme.test")).toBe(false);
	});

	it("matches the display name when one is given", () => {
		const m = built();
		expect(m.hasRecipient("to", "ada@acme.test", "Ada")).toBe(true);
		expect(m.hasRecipient("to", "ada@acme.test", "Grace")).toBe(false);
	});

	it("hasAnyRecipient is the any-field question", () => {
		const m = built();
		expect(m.hasAnyRecipient("cc@acme.test")).toBe(true);
		expect(m.hasAnyRecipient("nobody@acme.test")).toBe(false);
		expect(m.hasAnyRecipient()).toBe(true);
	});
});
