import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Mail, type MailMessage, MessageBuilder } from "../../src/index.js";
import { BrevoTransport } from "../../src/transports/BrevoTransport.js";
import { MailgunTransport } from "../../src/transports/MailgunTransport.js";
import { ResendTransport } from "../../src/transports/ResendTransport.js";
import { SendGridTransport } from "../../src/transports/SendGridTransport.js";
import { SesTransport } from "../../src/transports/SesTransport.js";
import { SparkPostTransport } from "../../src/transports/SparkPostTransport.js";
import { type FakeSmtp, startFakeSmtp } from "../__helpers__/fakeSmtp.js";

let server: FakeSmtp | undefined;

afterEach(async () => {
	await server?.close();
	server = undefined;
});

describe("rover > envelope() decides MAIL FROM / RCPT TO", () => {
	it("SMTP uses the envelope, not the headers", async () => {
		server = await startFakeSmtp();
		const mail = new Mail({
			default: "smtp",
			from: "app@example.com",
			mailers: {
				smtp: {
					transport: "smtp",
					host: "127.0.0.1",
					port: server.port,
					retry: { maxAttempts: 1 },
				},
			},
		});
		await mail.send((m) =>
			m
				.to("bob@example.com")
				.envelope({ from: "bounce@example.com", to: ["env-only@example.com"] })
				.subject("s")
				.text("x"),
		);
		const envelope = server.commands().filter((c) => /^(MAIL|RCPT) /i.test(c));
		expect(envelope).toEqual([
			"MAIL FROM:<bounce@example.com>",
			"RCPT TO:<env-only@example.com>",
		]);
		// The headers still name the visible recipient.
		expect(server.sessions[0]?.data[0]).toMatch(/^To: bob@example.com/m);
	});

	it("a bounce address alone still delivers to the header recipients", async () => {
		server = await startFakeSmtp();
		const mail = new Mail({
			default: "smtp",
			from: "app@example.com",
			mailers: {
				smtp: {
					transport: "smtp",
					host: "127.0.0.1",
					port: server.port,
					retry: { maxAttempts: 1 },
				},
			},
		});
		await mail.send((m) =>
			m
				.to("bob@example.com")
				.bcc("hidden@example.com")
				.envelope({ from: "bounces+bob@example.com" })
				.subject("s")
				.text("x"),
		);
		expect(server.commands().filter((c) => /^(MAIL|RCPT) /i.test(c))).toEqual([
			"MAIL FROM:<bounces+bob@example.com>",
			"RCPT TO:<bob@example.com>",
			"RCPT TO:<hidden@example.com>",
		]);
	});

	it.each([
		["a list in from", { from: "a@example.com, evil@attacker.test" }],
		["a list in to", { to: "a@example.com, evil@attacker.test" }],
		[
			"a CRLF in to[]",
			{ to: ["a@example.com\r\nRCPT TO:<evil@attacker.test>"] },
		],
		["a display form in bcc", { bcc: "Evil <evil@attacker.test>" }],
	])("rejects %s", (_label, envelope) => {
		expect(() => new MessageBuilder().envelope(envelope)).toThrow(
			expect.objectContaining({
				code: expect.stringMatching(
					/E_MAIL_INVALID_ADDRESS|E_MAIL_HEADER_INJECTION/,
				),
			}),
		);
	});

	it("re-checks the envelope of a message that skipped the builder", async () => {
		const mail = new Mail({
			default: "log",
			from: "app@example.com",
			mailers: { log: { transport: "log" } },
		});
		await expect(
			mail.sendCompiled({
				from: "app@example.com",
				to: ["a@example.com"],
				cc: [],
				bcc: [],
				subject: "s",
				attachments: [],
				headers: {},
				envelope: { to: "a@example.com, evil@attacker.test" },
			}),
		).rejects.toMatchObject({ code: "E_MAIL_INVALID_ADDRESS" });
	});
});

describe("rover > a provider that cannot carry the envelope says so", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("{}", { status: 200 }));
	});
	afterEach(() => fetchSpy.mockRestore());

	const message = (): MailMessage => ({
		from: "app@example.com",
		to: ["bob@example.com"],
		cc: [],
		bcc: [],
		subject: "s",
		text: "x",
		attachments: [],
		headers: {},
		envelope: { from: "bounce@example.com", to: "env-only@example.com" },
	});

	it.each([
		["sendgrid", () => new SendGridTransport({ apiKey: "k" })],
		["resend", () => new ResendTransport({ apiKey: "k" })],
		["brevo", () => new BrevoTransport({ apiKey: "k" })],
		["mailgun", () => new MailgunTransport({ apiKey: "k", domain: "d.test" })],
		["sparkpost", () => new SparkPostTransport({ apiKey: "k" })],
		[
			"ses",
			() =>
				new SesTransport({
					region: "eu-west-1",
					accessKeyId: "AKID",
					secretAccessKey: "secret",
				}),
		],
	])("%s", async (_name, make) => {
		await expect(make().send(message())).rejects.toMatchObject({
			code: "E_MAIL_FIELD_UNSUPPORTED",
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
