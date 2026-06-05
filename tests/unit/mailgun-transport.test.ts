import { ReamError } from "@c9up/ream";
import { describe, expect, it, vi } from "vitest";
import type { MailMessage } from "../../src/index.js";
import { MailgunTransport } from "../../src/transports/MailgunTransport.js";

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
	domain: string;
	data: Record<string, unknown>;
}

const makeFakeClient = (behaviour: {
	id?: string | null;
	throwError?: unknown;
}): {
	client: { messages: { create: ReturnType<typeof vi.fn> } };
	calls: RecordedCall[];
} => {
	const calls: RecordedCall[] = [];
	const create = vi.fn(
		async (domain: string, data: Record<string, unknown>) => {
			calls.push({ domain, data });
			if (behaviour.throwError) throw behaviour.throwError;
			// `id: null` = caller opts out explicitly; no key at all means default.
			const id =
				behaviour.id === null
					? undefined
					: (behaviour.id ?? "<mg-msg-default@mailgun.org>");
			return id !== undefined ? { id } : {};
		},
	);
	return { client: { messages: { create } }, calls };
};

describe("rover > MailgunTransport (mailgun.js)", () => {
	it("calls client.messages.create with domain + from/to/subject/html/text", async () => {
		const { client, calls } = makeFakeClient({ id: "<mg-1@mailgun.org>" });
		const t = new MailgunTransport({
			apiKey: "k",
			domain: "mg.acme.com",
			_client: client,
		});
		const result = await t.send(baseMessage());

		expect(calls).toHaveLength(1);
		expect(calls[0].domain).toBe("mg.acme.com");
		expect(calls[0].data.from).toBe("sender@example.com");
		expect(calls[0].data.to).toEqual(["user@example.com"]);
		expect(calls[0].data.subject).toBe("Hello");
		expect(calls[0].data.html).toBe("<p>Hi</p>");
		expect(calls[0].data.text).toBe("Hi");
		expect(result).toEqual({ providerId: "<mg-1@mailgun.org>" });
	});

	it("forwards cc, bcc, replyTo, custom headers, attachments", async () => {
		const { client, calls } = makeFakeClient({});
		const t = new MailgunTransport({
			apiKey: "k",
			domain: "d",
			_client: client,
		});
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
		expect(data["h:Reply-To"]).toBe("reply@x.com");
		expect(data["h:X-Campaign"]).toBe("summer");
		expect(Array.isArray(data.attachment)).toBe(true);
		const atts = data.attachment as Array<{
			filename: string;
			data: Buffer;
			contentType?: string;
		}>;
		expect(atts[0].filename).toBe("a.pdf");
		expect(Buffer.isBuffer(atts[0].data)).toBe(true);
		expect(atts[0].contentType).toBe("application/pdf");
	});

	it("throws MAIL_PROVIDER_CONFIG when message has no recipients", async () => {
		const { client } = makeFakeClient({});
		const t = new MailgunTransport({
			apiKey: "k",
			domain: "d",
			_client: client,
		});
		const msg = baseMessage();
		msg.to = [];
		await expect(t.send(msg)).rejects.toMatchObject({
			code: "MAIL_PROVIDER_CONFIG",
		});
	});

	it("throws MAIL_PROVIDER_ERROR wrapping mailgun.js errors", async () => {
		const mailgunErr = Object.assign(new Error("Unauthorized"), {
			status: 401,
			details: "Invalid api key",
		});
		const { client } = makeFakeClient({ throwError: mailgunErr });
		const t = new MailgunTransport({
			apiKey: "bad",
			domain: "d",
			_client: client,
		});
		await expect(t.send(baseMessage())).rejects.toMatchObject({
			code: "MAIL_PROVIDER_ERROR",
			context: {
				provider: "mailgun",
				upstreamStatus: "401",
				providerMessage: expect.stringContaining("Invalid api key"),
			},
		});
	});

	it("wraps errors as ReamError instances", async () => {
		const { client } = makeFakeClient({
			throwError: Object.assign(new Error("boom"), { status: 500 }),
		});
		const t = new MailgunTransport({
			apiKey: "k",
			domain: "d",
			_client: client,
		});
		await expect(t.send(baseMessage())).rejects.toBeInstanceOf(ReamError);
	});

	it("normalizes region (accepts 'EU' as 'eu', rejects unknown values)", () => {
		const { client } = makeFakeClient({});
		expect(
			() =>
				new MailgunTransport({
					apiKey: "k",
					domain: "d",
					region: "EU",
					_client: client,
				}),
		).not.toThrow();
		expect(
			() =>
				new MailgunTransport({
					apiKey: "k",
					domain: "d",
					region: "us-east-1",
					_client: client,
				}),
		).toThrow(/must be "us" or "eu"/);
	});

	it("trims CRLF/whitespace from config strings", async () => {
		const { client, calls } = makeFakeClient({});
		const t = new MailgunTransport({
			apiKey: "k\n",
			domain: " d\r\n",
			region: " us ",
			_client: client,
		});
		await t.send(baseMessage());
		expect(calls[0].domain).toBe("d");
	});

	it("throws config error when apiKey or domain missing", () => {
		expect(() => new MailgunTransport({ domain: "d" })).toThrow(
			"apiKey and domain",
		);
		expect(() => new MailgunTransport({ apiKey: "k" })).toThrow(
			"apiKey and domain",
		);
	});

	it("strips CRLF from `to`, `subject`, `replyTo`, header values, attachment metadata (AC 6)", async () => {
		const { client, calls } = makeFakeClient({});
		const t = new MailgunTransport({
			apiKey: "k",
			domain: "d",
			_client: client,
		});
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
		expect(data["h:Reply-To"]).toBe("r@x.comInj: yes");
		expect(data["h:X-CampHdr"]).toBe("valBcc: victim@z.com");
		const atts = data.attachment as Array<{
			filename: string;
			contentType?: string;
		}>;
		expect(atts[0].filename).toBe("f.pdfX-Evil: 1");
		expect(atts[0].contentType).toBe("application/pdfX-Evil: 2");
	});

	it("wraps bare Error (no .status) preserving networkCode for retry", async () => {
		const netErr = Object.assign(new Error("socket hang up"), {
			code: "ECONNRESET",
		});
		const { client } = makeFakeClient({ throwError: netErr });
		const t = new MailgunTransport({
			apiKey: "k",
			domain: "d",
			_client: client,
		});
		await expect(t.send(baseMessage())).rejects.toMatchObject({
			code: "MAIL_PROVIDER_ERROR",
			context: {
				provider: "mailgun",
				upstreamStatus: "0",
				networkCode: "ECONNRESET",
			},
		});
	});

	it("coerces string-typed status to number", async () => {
		const strErr = Object.assign(new Error("Forbidden"), {
			status: "403",
			details: "access denied",
		});
		const { client } = makeFakeClient({ throwError: strErr });
		const t = new MailgunTransport({
			apiKey: "k",
			domain: "d",
			_client: client,
		});
		await expect(t.send(baseMessage())).rejects.toMatchObject({
			context: { upstreamStatus: "403" },
		});
	});

	it("rejects non-string region (compliance: prevents silent US fallback)", () => {
		expect(
			() => new MailgunTransport({ apiKey: "k", domain: "d", region: 42 }),
		).toThrow(/region must be a string/);
	});

	it("returns undefined providerId when SDK omits the id", async () => {
		const { client } = makeFakeClient({ id: null });
		const t = new MailgunTransport({
			apiKey: "k",
			domain: "d",
			_client: client,
		});
		const result = await t.send(baseMessage());
		expect(result).toBeUndefined();
	});
});
