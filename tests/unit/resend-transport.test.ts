import { Buffer } from "node:buffer";
import { ReamError } from "@c9up/ream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailMessage } from "../../src/index.js";
import { ResendTransport } from "../../src/transports/ResendTransport.js";

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

interface ResendPayload {
	from: string;
	to: string[];
	cc?: string[];
	bcc?: string[];
	reply_to?: string;
	subject: string;
	html?: string;
	text?: string;
	attachments?: Array<{
		filename: string;
		content: string;
		content_type?: string;
	}>;
}

const parseBody = (
	call: [string | URL | Request, RequestInit | undefined],
): ResendPayload => JSON.parse(call[1]?.body as string) as ResendPayload;

describe("rover > ResendTransport", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("{}", { status: 200 }));
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("POSTs to api.resend.com/emails with Bearer auth and JSON content-type", async () => {
		const t = new ResendTransport({ apiKey: "re_abc" });
		await t.send(baseMessage());

		const [url, init] = fetchSpy.mock.calls[0];
		expect(url).toBe("https://api.resend.com/emails");
		expect((init?.headers as Record<string, string>).Authorization).toBe(
			"Bearer re_abc",
		);
		expect((init?.headers as Record<string, string>)["Content-Type"]).toBe(
			"application/json",
		);
	});

	it("builds JSON body with from/to/subject/html/text and includes reply_to when set", async () => {
		const t = new ResendTransport({ apiKey: "k" });
		const msg = baseMessage();
		msg.cc = ["cc@example.com"];
		msg.bcc = ["bcc@example.com"];
		msg.replyTo = "reply@example.com";
		await t.send(msg);

		const body = parseBody(fetchSpy.mock.calls[0]);
		expect(body.from).toBe("sender@example.com");
		expect(body.to).toEqual(["user@example.com"]);
		expect(body.cc).toEqual(["cc@example.com"]);
		expect(body.bcc).toEqual(["bcc@example.com"]);
		expect(body.reply_to).toBe("reply@example.com");
		expect(body.subject).toBe("Hello");
		expect(body.html).toBe("<p>Hi</p>");
		expect(body.text).toBe("Hi");
	});

	it("omits optional fields when not set", async () => {
		const t = new ResendTransport({ apiKey: "k" });
		await t.send(baseMessage());

		const body = parseBody(fetchSpy.mock.calls[0]);
		expect(body.cc).toBeUndefined();
		expect(body.bcc).toBeUndefined();
		expect(body.reply_to).toBeUndefined();
	});

	it("base64-encodes attachment content and preserves filename + content_type", async () => {
		const t = new ResendTransport({ apiKey: "k" });
		const msg = baseMessage();
		msg.attachments = [
			{
				filename: "invoice.pdf",
				content: "PDFBYTES",
				contentType: "application/pdf",
			},
		];
		await t.send(msg);

		const body = parseBody(fetchSpy.mock.calls[0]);
		expect(body.attachments).toHaveLength(1);
		expect(body.attachments?.[0]).toEqual({
			filename: "invoice.pdf",
			content: Buffer.from("PDFBYTES").toString("base64"),
			content_type: "application/pdf",
		});
	});

	it("strips CRLF from recipients, subject, reply-to", async () => {
		const t = new ResendTransport({ apiKey: "k" });
		const msg = baseMessage();
		msg.to = ["user@x.com\r\nX-Injected: evil"];
		msg.subject = "Hi\r\nBcc: victim@y.com";
		msg.replyTo = "reply@x.com\r\nEvil: yes";
		await t.send(msg);

		const body = parseBody(fetchSpy.mock.calls[0]);
		expect(body.to).toEqual(["user@x.comX-Injected: evil"]);
		expect(body.subject).toBe("HiBcc: victim@y.com");
		expect(body.reply_to).toBe("reply@x.comEvil: yes");
	});

	it("throws MAIL_PROVIDER_ERROR on 422", async () => {
		fetchSpy.mockResolvedValue(
			new Response('{"name":"validation_error"}', { status: 422 }),
		);
		const t = new ResendTransport({ apiKey: "k" });
		await expect(t.send(baseMessage())).rejects.toMatchObject({
			code: "MAIL_PROVIDER_ERROR",
			context: {
				provider: "resend",
				upstreamStatus: "422",
			},
		});
	});

	it("throws ReamError on 5xx", async () => {
		fetchSpy.mockResolvedValue(new Response("boom", { status: 500 }));
		const t = new ResendTransport({ apiKey: "k" });
		await expect(t.send(baseMessage())).rejects.toBeInstanceOf(ReamError);
	});

	it("returns { providerId } from Resend success JSON body", async () => {
		fetchSpy.mockResolvedValue(
			new Response(JSON.stringify({ id: "res-abc-123" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		const t = new ResendTransport({ apiKey: "k" });
		const result = await t.send(baseMessage());
		expect(result).toEqual({ providerId: "res-abc-123" });
	});

	it("throws config error when apiKey is missing", () => {
		expect(() => new ResendTransport({})).toThrow("apiKey");
	});

	it("captures Retry-After header in error context when set", async () => {
		fetchSpy.mockResolvedValue(
			new Response("rate limited", {
				status: 429,
				headers: { "Retry-After": "10" },
			}),
		);
		const t = new ResendTransport({ apiKey: "k" });
		await expect(t.send(baseMessage())).rejects.toMatchObject({
			context: { retryAfter: "10", upstreamStatus: "429" },
		});
	});

	it("redacts Bearer tokens echoed in providerMessage", async () => {
		fetchSpy.mockResolvedValue(
			new Response("sent Bearer re_abc.def", { status: 401 }),
		);
		const t = new ResendTransport({ apiKey: "k" });
		await expect(t.send(baseMessage())).rejects.toMatchObject({
			context: {
				providerMessage: expect.stringContaining("Bearer [REDACTED]"),
			},
		});
	});

	it("trims CRLF/whitespace from apiKey config", async () => {
		const t = new ResendTransport({ apiKey: "re_abc\r\n" });
		await t.send(baseMessage());
		const auth = (fetchSpy.mock.calls[0][1]?.headers as Record<string, string>)
			.Authorization;
		expect(auth).toBe("Bearer re_abc");
	});

	it("throws MAIL_PROVIDER_CONFIG when message has no recipients", async () => {
		const t = new ResendTransport({ apiKey: "k" });
		const msg = baseMessage();
		msg.to = [];
		await expect(t.send(msg)).rejects.toMatchObject({
			code: "MAIL_PROVIDER_CONFIG",
		});
	});
});
