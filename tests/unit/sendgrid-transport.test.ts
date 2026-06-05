import { ReamError } from "@c9up/ream";
import { describe, expect, it, vi } from "vitest";
import type { MailMessage } from "../../src/index.js";
import { SendGridTransport } from "../../src/transports/SendGridTransport.js";

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

interface RecordedCall {
	data: Record<string, unknown>;
}

const makeFakeClient = (behaviour: {
	messageId?: string;
	throwError?: unknown;
}): {
	client: {
		setApiKey: ReturnType<typeof vi.fn>;
		send: ReturnType<typeof vi.fn>;
	};
	calls: RecordedCall[];
} => {
	const calls: RecordedCall[] = [];
	const setApiKey = vi.fn();
	const send = vi.fn(async (data: Record<string, unknown>) => {
		calls.push({ data });
		if (behaviour.throwError) throw behaviour.throwError;
		return [
			{
				statusCode: 202,
				headers: behaviour.messageId
					? { "x-message-id": behaviour.messageId }
					: {},
			},
			{},
		] as const;
	});
	return { client: { setApiKey, send }, calls };
};

describe("rover > SendGridTransport (@sendgrid/mail)", () => {
	it("sets the apiKey on the SDK client and calls send() with shape", async () => {
		const { client, calls } = makeFakeClient({ messageId: "sg-abc-xyz" });
		const t = new SendGridTransport({ apiKey: "SG.k", _client: client });
		expect(client.setApiKey).toHaveBeenCalledWith("SG.k");

		const result = await t.send(baseMessage());
		expect(calls).toHaveLength(1);
		expect(calls[0].data.from).toBe("sender@example.com");
		expect(calls[0].data.to).toEqual(["user@example.com"]);
		expect(calls[0].data.subject).toBe("Hello");
		// SendGrid v3 canonical shape: `content` array holding text + html.
		const content = calls[0].data.content as Array<{
			type: string;
			value: string;
		}>;
		expect(content).toContainEqual({ type: "text/plain", value: "Hi" });
		expect(content).toContainEqual({ type: "text/html", value: "<p>Hi</p>" });
		expect(result).toEqual({ providerId: "sg-abc-xyz" });
	});

	it("forwards cc, bcc, replyTo, custom headers, and base64 attachments", async () => {
		const { client, calls } = makeFakeClient({});
		const t = new SendGridTransport({ apiKey: "k", _client: client });
		const msg = baseMessage();
		msg.cc = ["cc@x.com"];
		msg.bcc = ["bcc@x.com"];
		msg.replyTo = "reply@x.com";
		msg.headers = { "X-Campaign": "summer" };
		msg.attachments = [
			{ filename: "a.pdf", content: "BYTES", contentType: "application/pdf" },
		];
		await t.send(msg);

		const data = calls[0].data;
		expect(data.cc).toEqual(["cc@x.com"]);
		expect(data.bcc).toEqual(["bcc@x.com"]);
		expect(data.replyTo).toBe("reply@x.com");
		expect(data.headers).toEqual({ "X-Campaign": "summer" });
		const atts = data.attachments as Array<{
			filename: string;
			content: string;
			type?: string;
			disposition: string;
		}>;
		expect(atts[0]).toEqual({
			filename: "a.pdf",
			content: Buffer.from("BYTES").toString("base64"),
			type: "application/pdf",
			disposition: "attachment",
		});
	});

	it("throws MAIL_PROVIDER_CONFIG when message has no recipients", async () => {
		const { client } = makeFakeClient({});
		const t = new SendGridTransport({ apiKey: "k", _client: client });
		const msg = baseMessage();
		msg.to = [];
		await expect(t.send(msg)).rejects.toMatchObject({
			code: "MAIL_PROVIDER_CONFIG",
		});
	});

	it("wraps SDK errors into MAIL_PROVIDER_ERROR with upstreamStatus + body", async () => {
		const sgErr = Object.assign(new Error("Unauthorized"), {
			code: 401,
			response: {
				statusCode: 401,
				body: { errors: [{ message: "invalid api key" }] },
				headers: {},
			},
		});
		const { client } = makeFakeClient({ throwError: sgErr });
		const t = new SendGridTransport({ apiKey: "bad", _client: client });
		await expect(t.send(baseMessage())).rejects.toMatchObject({
			code: "MAIL_PROVIDER_ERROR",
			context: {
				provider: "sendgrid",
				upstreamStatus: "401",
				providerMessage: expect.stringContaining("invalid api key"),
			},
		});
	});

	it("captures Retry-After header from SDK error headers", async () => {
		const sgErr = Object.assign(new Error("Rate limit"), {
			code: 429,
			response: {
				statusCode: 429,
				body: "rate-limited",
				headers: { "retry-after": "60" },
			},
		});
		const { client } = makeFakeClient({ throwError: sgErr });
		const t = new SendGridTransport({ apiKey: "k", _client: client });
		await expect(t.send(baseMessage())).rejects.toMatchObject({
			context: { retryAfter: "60", upstreamStatus: "429" },
		});
	});

	it("wraps errors as ReamError instances", async () => {
		const { client } = makeFakeClient({
			throwError: Object.assign(new Error("boom"), { code: 500 }),
		});
		const t = new SendGridTransport({ apiKey: "k", _client: client });
		await expect(t.send(baseMessage())).rejects.toBeInstanceOf(ReamError);
	});

	it("throws config error when apiKey is missing", () => {
		expect(() => new SendGridTransport({})).toThrow("apiKey");
	});

	it("trims CRLF/whitespace from apiKey config", () => {
		const { client } = makeFakeClient({});
		const _t = new SendGridTransport({ apiKey: "SG.abc\n", _client: client });
		expect(client.setApiKey).toHaveBeenCalledWith("SG.abc");
		void _t;
	});

	it("strips CRLF from `to`, `subject`, `replyTo`, headers, attachment meta (AC 6)", async () => {
		const { client, calls } = makeFakeClient({});
		const t = new SendGridTransport({ apiKey: "k", _client: client });
		const msg = baseMessage();
		msg.to = ["u@x.com\r\nX-Injected: evil"];
		msg.subject = "Hi\r\nBcc: victim@y.com";
		msg.replyTo = "r@x.com\r\nInj: yes";
		msg.headers = { "X-Camp\r\nHdr": "val\r\nBcc: victim@z.com" };
		msg.attachments = [
			{
				filename: "f.pdf\r\nX-Evil: 1",
				content: "x",
				contentType: "application/pdf\r\nX-Evil: 2",
			},
		];
		await t.send(msg);

		const data = calls[0].data;
		expect(data.to).toEqual(["u@x.comX-Injected: evil"]);
		expect(data.subject).toBe("HiBcc: victim@y.com");
		expect(data.replyTo).toBe("r@x.comInj: yes");
		expect(data.headers).toEqual({ "X-CampHdr": "valBcc: victim@z.com" });
		const atts = data.attachments as Array<{
			filename: string;
			type?: string;
		}>;
		expect(atts[0].filename).toBe("f.pdfX-Evil: 1");
		expect(atts[0].type).toBe("application/pdfX-Evil: 2");
	});

	it("wraps bare Error (no HTTP response) with networkCode for retry", async () => {
		const netErr = Object.assign(new Error("socket hang up"), {
			code: "ECONNRESET",
		});
		const { client } = makeFakeClient({ throwError: netErr });
		const t = new SendGridTransport({ apiKey: "k", _client: client });
		await expect(t.send(baseMessage())).rejects.toMatchObject({
			code: "MAIL_PROVIDER_ERROR",
			context: {
				provider: "sendgrid",
				upstreamStatus: "0",
				networkCode: "ECONNRESET",
			},
		});
	});

	it("emits content[] with only the parts present (html-only, no empty text)", async () => {
		const { client, calls } = makeFakeClient({});
		const t = new SendGridTransport({ apiKey: "k", _client: client });
		const msg = baseMessage();
		msg.text = undefined;
		await t.send(msg);

		const content = calls[0].data.content as Array<{
			type: string;
			value: string;
		}>;
		expect(content).toHaveLength(1);
		expect(content[0]).toEqual({ type: "text/html", value: "<p>Hi</p>" });
	});

	it("does not crash when SDK returns `[undefined, body]`", async () => {
		const client = {
			setApiKey: vi.fn(),
			send: vi.fn(
				async () =>
					[undefined, {}] as unknown as [
						{ statusCode: number; headers: Record<string, string | string[]> },
						unknown,
					],
			),
		};
		const t = new SendGridTransport({ apiKey: "k", _client: client });
		await expect(t.send(baseMessage())).resolves.toBeUndefined();
	});

	it("returns undefined providerId when the SDK response has no X-Message-Id", async () => {
		const { client } = makeFakeClient({ messageId: undefined });
		const t = new SendGridTransport({ apiKey: "k", _client: client });
		const result = await t.send(baseMessage());
		expect(result).toBeUndefined();
	});
});
