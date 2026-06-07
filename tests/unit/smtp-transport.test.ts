import { RoverError } from "../../src/RoverError.js";
import { describe, expect, it, vi } from "vitest";
import type { MailMessage } from "../../src/index.js";
import { SmtpTransport } from "../../src/index.js";

const baseMessage = (): MailMessage => ({
	from: "sender@example.com",
	to: ["user@example.com"],
	cc: [],
	bcc: [],
	subject: "Hello",
	html: "<p>Hi</p>",
	text: "Hi",
	attachments: [],
	headers: {},
});

interface FakeNodemailerTransporter {
	sendMail: ReturnType<typeof vi.fn>;
}

const makeFakeTransporter = (
	behaviour: { messageId?: string; throwError?: unknown } = {},
): FakeNodemailerTransporter => ({
	sendMail: vi.fn(async () => {
		if (behaviour.throwError) throw behaviour.throwError;
		return { messageId: behaviour.messageId ?? "<smtp-abc@local>" };
	}),
});

describe("rover > SmtpTransport (nodemailer)", () => {
	it("calls transporter.sendMail with from/to/subject/html/text and returns providerId", async () => {
		const transporter = makeFakeTransporter({ messageId: "<xyz@smtp>" });
		const t = new SmtpTransport({
			host: "mail.acme.com",
			port: 587,
			_transporter: transporter,
		});
		const result = await t.send(baseMessage());
		expect(transporter.sendMail).toHaveBeenCalledOnce();
		const arg = transporter.sendMail.mock.calls[0][0];
		expect(arg.from).toBe("sender@example.com");
		expect(arg.to).toEqual(["user@example.com"]);
		expect(arg.subject).toBe("Hello");
		expect(arg.html).toBe("<p>Hi</p>");
		expect(arg.text).toBe("Hi");
		expect(result).toEqual({ providerId: "<xyz@smtp>" });
	});

	it("forwards replyTo, cc, bcc, headers and attachments only when present", async () => {
		const transporter = makeFakeTransporter({});
		const t = new SmtpTransport({
			host: "m",
			_transporter: transporter,
		});
		const msg = baseMessage();
		msg.cc = ["cc@x.com"];
		msg.replyTo = "r@x.com";
		msg.headers = { "X-Campaign": "summer" };
		msg.attachments = [
			{ filename: "a.pdf", content: "bytes", contentType: "application/pdf" },
		];
		await t.send(msg);
		const arg = transporter.sendMail.mock.calls[0][0];
		expect(arg.cc).toEqual(["cc@x.com"]);
		expect(arg.bcc).toBeUndefined();
		expect(arg.replyTo).toBe("r@x.com");
		expect(arg.headers).toEqual({ "X-Campaign": "summer" });
		expect(arg.attachments).toEqual([
			{
				filename: "a.pdf",
				content: "bytes",
				contentType: "application/pdf",
			},
		]);
	});

	it("throws MAIL_PROVIDER_CONFIG when message has no recipients", async () => {
		const transporter = makeFakeTransporter({});
		const t = new SmtpTransport({ host: "m", _transporter: transporter });
		const msg = baseMessage();
		msg.to = [];
		await expect(t.send(msg)).rejects.toMatchObject({
			code: "MAIL_PROVIDER_CONFIG",
		});
	});

	it("wraps bare Error (ECONNRESET) preserving networkCode for retry", async () => {
		const netErr = Object.assign(new Error("socket hang up"), {
			code: "ECONNRESET",
		});
		const transporter = makeFakeTransporter({ throwError: netErr });
		const t = new SmtpTransport({ host: "m", _transporter: transporter });
		await expect(t.send(baseMessage())).rejects.toMatchObject({
			code: "MAIL_PROVIDER_ERROR",
			context: {
				provider: "smtp",
				networkCode: "ECONNRESET",
			},
		});
	});

	it("captures SMTP response code into upstreamStatus", async () => {
		const smtpErr = Object.assign(new Error("550 mailbox unavailable"), {
			responseCode: 550,
		});
		const transporter = makeFakeTransporter({ throwError: smtpErr });
		const t = new SmtpTransport({ host: "m", _transporter: transporter });
		await expect(t.send(baseMessage())).rejects.toMatchObject({
			context: { upstreamStatus: "550" },
		});
	});

	it("rejects host of wrong type (not a string)", () => {
		expect(() => new SmtpTransport({ host: 42 })).toThrow(
			/host must be a string/,
		);
	});

	it("rejects partial auth config (user without pass)", () => {
		expect(() => new SmtpTransport({ host: "m", user: "u" })).toThrow(
			/SMTP auth requires both/,
		);
		expect(() => new SmtpTransport({ host: "m", pass: "p" })).toThrow(
			/SMTP auth requires both/,
		);
	});

	it("accepts auth with both user and pass", () => {
		const transporter = makeFakeTransporter({});
		expect(
			() =>
				new SmtpTransport({
					host: "m",
					user: "u",
					pass: "p",
					_transporter: transporter,
				}),
		).not.toThrow();
	});

	it("wraps errors as RoverError instances", async () => {
		const transporter = makeFakeTransporter({
			throwError: new Error("boom"),
		});
		const t = new SmtpTransport({ host: "m", _transporter: transporter });
		await expect(t.send(baseMessage())).rejects.toBeInstanceOf(RoverError);
	});
});
