import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Mail, MessageBuilder } from "../../src/index.js";
import { BrevoTransport } from "../../src/transports/BrevoTransport.js";
import { SendGridTransport } from "../../src/transports/SendGridTransport.js";
import { SparkPostTransport } from "../../src/transports/SparkPostTransport.js";
import { requestBody } from "../__helpers__/defined.js";
import { type FakeSmtp, startFakeSmtp } from "../__helpers__/fakeSmtp.js";

let server: FakeSmtp | undefined;

afterEach(async () => {
	await server?.close();
	server = undefined;
});

async function smtpSend(build: (m: MessageBuilder) => void): Promise<FakeSmtp> {
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
	await mail.send((m) => {
		build(m);
		m.subject("s").text("x");
	});
	return server;
}

const rcpts = (s: FakeSmtp) =>
	s.commands().filter((c) => c.toUpperCase().startsWith("RCPT"));

describe("rover > one to()/cc()/bcc()/replyTo() argument is one mailbox", () => {
	it.each([
		[
			"to with a name",
			(m: MessageBuilder) =>
				m.to("bob@example.com>, <evil@attacker.test", "Bob"),
		],
		[
			"replyTo with a name",
			(m: MessageBuilder) =>
				m.replyTo("r@example.com>, <evil@attacker.test", "R"),
		],
		[
			"bare comma list",
			(m: MessageBuilder) => m.to("bob@example.com, evil@attacker.test"),
		],
		[
			"semicolon list",
			(m: MessageBuilder) => m.cc("bob@example.com; evil@attacker.test"),
		],
		["angle brackets", (m: MessageBuilder) => m.bcc("<evil@attacker.test>")],
		["display form", (m: MessageBuilder) => m.to("Bob <bob@example.com>")],
		[
			"array entry list",
			(m: MessageBuilder) => m.to(["bob@example.com, evil@attacker.test"]),
		],
		[
			"object entry list",
			(m: MessageBuilder) =>
				m.to([{ address: "a@x.test, evil@attacker.test", name: "A" }]),
		],
		[
			"from",
			(m: MessageBuilder) => m.from("app@example.com, evil@attacker.test"),
		],
	])("rejects %s", (_label, build) => {
		expect(() => build(new MessageBuilder())).toThrow(
			expect.objectContaining({ code: "E_MAIL_INVALID_ADDRESS" }),
		);
	});

	it.each([
		["\r\n", "bob@example.com\r\nBcc: evil@attacker.test"],
		["\n", "bob@example.com\nBcc: evil@attacker.test"],
		["\r", "bob@example.com\rBcc: evil@attacker.test"],
		["\\0", "bob@example.com\0evil@attacker.test"],
	])(
		"string entries of to([...])/cc([...])/bcc([...]) reject %s",
		(_label, entry) => {
			for (const method of ["to", "cc", "bcc"] as const) {
				expect(() => new MessageBuilder()[method]([entry])).toThrow(
					expect.objectContaining({ code: "E_MAIL_HEADER_INJECTION" }),
				);
			}
		},
	);

	it("delivers a named recipient to exactly one RCPT", async () => {
		const s = await smtpSend((m) =>
			m.to("bob@example.com", 'Bob "The Builder", O\\Neil <x@y>'),
		);
		expect(rcpts(s)).toEqual(["RCPT TO:<bob@example.com>"]);
	});

	it("keeps object entries of to([...]) working", async () => {
		const s = await smtpSend((m) =>
			m.to([{ address: "a@example.com", name: "A" }, "b@example.com"]),
		);
		expect(rcpts(s)).toEqual([
			"RCPT TO:<a@example.com>",
			"RCPT TO:<b@example.com>",
		]);
	});

	it("stores recipients in the AdonisJS shape", async () => {
		const m = new MessageBuilder()
			.from("app@example.com", "App")
			.to("a@example.com", "Ada")
			.to("b@example.com")
			.replyTo("r@example.com", "R");
		const built = await m.build();
		expect(built.from).toEqual({ address: "app@example.com", name: "App" });
		expect(built.to).toEqual([
			{ address: "a@example.com", name: "Ada" },
			"b@example.com",
		]);
		expect(m.hasTo("a@example.com", "Ada")).toBe(true);
		expect(m.hasTo("a@example.com")).toBe(true);
		expect(m.hasTo("a@example.com", "Bob")).toBe(false);
		expect(m.hasTo("b@example.com")).toBe(true);
		expect(m.hasReplyTo("r@example.com", "R")).toBe(true);
	});

	it("accepts non-ASCII names and internationalised addresses", () => {
		const m = new MessageBuilder()
			.to("zoe@exämple.com", "Zoë Corp")
			.to("用户@例子.广告");
		expect(m.hasTo("zoe@exämple.com", "Zoë Corp")).toBe(true);
	});
});

describe("rover > HTTP transports map names without re-parsing", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("{}", { status: 202 }));
	});
	afterEach(() => fetchSpy.mockRestore());

	const name = 'Bob "The Builder" O\\Neil';
	const message = async () =>
		new MessageBuilder()
			.from("app@example.com", "Acme")
			.to("bob@example.com", name)
			.subject("s")
			.text("x")
			.build();

	it("SendGrid sends { email, name }", async () => {
		await new SendGridTransport({ apiKey: "k" }).send(await message());
		const body: unknown = JSON.parse(requestBody(fetchSpy.mock.calls));
		expect(body).toMatchObject({
			personalizations: [{ to: [{ email: "bob@example.com", name }] }],
			from: { email: "app@example.com", name: "Acme" },
		});
	});

	it("Brevo sends the name unescaped", async () => {
		fetchSpy.mockResolvedValue(
			new Response('{"messageId":"x"}', { status: 201 }),
		);
		await new BrevoTransport({ apiKey: "k" }).send(await message());
		const body: unknown = JSON.parse(requestBody(fetchSpy.mock.calls));
		expect(body).toMatchObject({
			sender: { email: "app@example.com", name: "Acme" },
			to: [{ email: "bob@example.com", name }],
		});
	});

	it("SparkPost puts one mailbox in the MIME To header and the address in recipients", async () => {
		fetchSpy.mockResolvedValue(
			new Response('{"results":{"id":"x"}}', { status: 200 }),
		);
		await new SparkPostTransport({ apiKey: "k" }).send(await message());
		const body: unknown = JSON.parse(requestBody(fetchSpy.mock.calls));
		expect(body).toMatchObject({
			recipients: [{ address: { email: "bob@example.com" } }],
		});
		const content =
			typeof body === "object" && body !== null
				? Reflect.get(body, "content")
				: undefined;
		const mime = String(
			typeof content === "object" && content !== null
				? Reflect.get(content, "email_rfc822")
				: "",
		);
		const to = mime.match(/^To: (.+)\r$/m)?.[1] ?? "";
		expect(to).toBe('"Bob \\"The Builder\\" O\\\\Neil" <bob@example.com>');
	});
});

describe("rover > replyTo() adds, as upstream's does", () => {
	it("keeps both addresses after two calls, on the wire too", async () => {
		const s = await smtpSend((m) =>
			m
				.to("bob@example.com")
				.replyTo("one@example.com")
				.replyTo("two@example.com", "Two"),
		);
		const data = s.sessions.flatMap((session) => session.data).join("\n");
		expect(data).toMatch(/Reply-To: one@example.com, Two <two@example.com>/);
	});
});
