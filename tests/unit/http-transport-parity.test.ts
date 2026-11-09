import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MailMessage, MessageBuilder } from "../../src/index.js";
import { BrevoTransport } from "../../src/transports/BrevoTransport.js";
import { MailgunTransport } from "../../src/transports/MailgunTransport.js";
import { ResendTransport } from "../../src/transports/ResendTransport.js";
import { SendGridTransport } from "../../src/transports/SendGridTransport.js";
import { SesTransport } from "../../src/transports/SesTransport.js";
import { SparkPostTransport } from "../../src/transports/SparkPostTransport.js";
import { requestInit } from "../__helpers__/defined.js";

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	fetchSpy = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async () => new Response("{}", { status: 200 }));
});
afterEach(() => fetchSpy.mockRestore());

const threaded = (): Promise<MailMessage> =>
	new MessageBuilder()
		.from("app@example.com")
		.to("bob@example.com")
		.subject("Re: order")
		.html('<img src="cid:logo">')
		.text("t")
		.messageId("<reply-2@example.com>")
		.inReplyTo("<order-1@example.com>")
		.references(["<order-1@example.com>"])
		.priority("high")
		.embedData(Buffer.from("PNG"), "logo", { contentType: "image/png" })
		.build();

/** Everything the transport put on the wire, as one searchable string. */
async function sentText(): Promise<string> {
	const body = requestInit(fetchSpy.mock.calls).body;
	if (typeof body === "string") {
		// SES form: RawMessage.Data carries the MIME, base64.
		const raw = new URLSearchParams(body).get("RawMessage.Data");
		return raw === null ? body : Buffer.from(raw, "base64").toString("utf8");
	}
	if (body instanceof FormData) {
		const file = body.get("message");
		return file instanceof Blob ? file.text() : "";
	}
	return "";
}

describe("rover > HTTP transports carry threading, priority and inline images", () => {
	it.each([
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
	])("%s sends them in nodemailer's MIME", async (_name, make) => {
		await make().send(await threaded());
		const mime = await sentText();
		const raw = mime.includes("email_rfc822")
			? String(Reflect.get(JSON.parse(mime), "content")?.email_rfc822)
			: mime;
		expect(raw).toMatch(/^Message-ID: <reply-2@example\.com>\r$/m);
		expect(raw).toMatch(/^In-Reply-To: <order-1@example\.com>\r$/m);
		expect(raw).toMatch(/^References: <order-1@example\.com>\r$/m);
		expect(raw).toMatch(/^X-Priority: 1 \(Highest\)\r$/m);
		expect(raw).toMatch(/^Content-Id: <logo>\r$/im);
		expect(raw).toMatch(/multipart\/related/);
	});

	it("resend sends the headers and the cid as content_id", async () => {
		await new ResendTransport({ apiKey: "k" }).send(await threaded());
		const body: unknown = JSON.parse(await sentText());
		expect(body).toMatchObject({
			headers: {
				"Message-ID": "<reply-2@example.com>",
				"In-Reply-To": "<order-1@example.com>",
				References: "<order-1@example.com>",
				"X-Priority": "1 (Highest)",
				Importance: "High",
			},
			attachments: [{ filename: "logo", content_id: "logo" }],
		});
	});

	it("sendgrid sends the headers and the cid as an inline content_id", async () => {
		await new SendGridTransport({ apiKey: "k" }).send(await threaded());
		const body: unknown = JSON.parse(await sentText());
		expect(body).toMatchObject({
			headers: {
				"Message-ID": "<reply-2@example.com>",
				"In-Reply-To": "<order-1@example.com>",
				References: "<order-1@example.com>",
				"X-Priority": "1 (Highest)",
			},
			attachments: [
				{ filename: "logo", disposition: "inline", content_id: "logo" },
			],
		});
	});

	it("brevo sends the headers", async () => {
		await new BrevoTransport({ apiKey: "k" }).send(await threaded());
		const body: unknown = JSON.parse(await sentText());
		expect(body).toMatchObject({
			headers: {
				"Message-ID": "<reply-2@example.com>",
				"In-Reply-To": "<order-1@example.com>",
				References: "<order-1@example.com>",
				"X-Priority": "1 (Highest)",
			},
		});
	});

	it("refuses a line break in a threading id", () => {
		expect(() => new MessageBuilder().messageId("<a@b>\r\nBcc: e@x")).toThrow(
			expect.objectContaining({ code: "E_MAIL_HEADER_INJECTION" }),
		);
		expect(() => new MessageBuilder().inReplyTo("<a@b>\nX: y")).toThrow(
			expect.objectContaining({ code: "E_MAIL_HEADER_INJECTION" }),
		);
		expect(() => new MessageBuilder().references(["<a@b>\r"])).toThrow(
			expect.objectContaining({ code: "E_MAIL_HEADER_INJECTION" }),
		);
	});
});
