import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailMessage } from "../../src/index.js";
import { RoverError } from "../../src/RoverError.js";
import { SesTransport } from "../../src/transports/SesTransport.js";
import { requestBody, requestHeaders } from "../__helpers__/defined.js";

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

const config = {
	accessKeyId: "AKIA-TEST",
	secretAccessKey: "secret",
	region: "us-east-1",
};

const parseForm = (body: string): Record<string, string[]> => {
	const out: Record<string, string[]> = {};
	for (const pair of body.split("&")) {
		const [k, v] = pair.split("=");
		const key = decodeURIComponent(k ?? "");
		const value = decodeURIComponent(v ?? "");
		if (!out[key]) out[key] = [];
		out[key].push(value);
	}
	return out;
};

describe("rover > SesTransport", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("", { status: 200 }));
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("POSTs to email.<region>.amazonaws.com", async () => {
		const t = new SesTransport({ ...config, region: "eu-west-1" });
		await t.send(baseMessage());

		const [url] = fetchSpy.mock.calls[0];
		expect(url).toBe("https://email.eu-west-1.amazonaws.com/");
	});

	it("uses SendEmail form body when no attachments", async () => {
		const t = new SesTransport(config);
		const msg = baseMessage();
		msg.cc = ["cc@example.com"];
		msg.replyTo = "reply@example.com";
		await t.send(msg);

		const form = parseForm(requestBody(fetchSpy.mock.calls));
		expect(form.Action).toEqual(["SendEmail"]);
		expect(form.Source).toEqual(["sender@example.com"]);
		expect(form["Destination.ToAddresses.member.1"]).toEqual([
			"user@example.com",
		]);
		expect(form["Destination.CcAddresses.member.1"]).toEqual([
			"cc@example.com",
		]);
		expect(form["ReplyToAddresses.member.1"]).toEqual(["reply@example.com"]);
		expect(form["Message.Subject.Data"]).toEqual(["Hello"]);
		expect(form["Message.Body.Html.Data"]).toEqual(["<p>Hi</p>"]);
		expect(form["Message.Body.Text.Data"]).toEqual(["Hi"]);
	});

	it("uses SendRawEmail when attachments present; MIME body contains attachment", async () => {
		const t = new SesTransport(config);
		const msg = baseMessage();
		msg.attachments = [
			{
				filename: "invoice.pdf",
				content: "PDFBYTES",
				contentType: "application/pdf",
			},
		];
		await t.send(msg);

		const form = parseForm(requestBody(fetchSpy.mock.calls));
		expect(form.Action).toEqual(["SendRawEmail"]);
		const rawB64 = form["RawMessage.Data"]?.[0] ?? "";
		const mime = Buffer.from(rawB64, "base64").toString("utf8");
		expect(mime).toContain("From: sender@example.com");
		expect(mime).toContain("Subject: Hello");
		expect(mime).toContain("Content-Disposition: attachment");
		expect(mime).toContain('filename="invoice.pdf"');
		// Attachment body is base64 `PDFBYTES` = `UERGQllURVM=`
		expect(mime).toContain(Buffer.from("PDFBYTES").toString("base64"));
	});

	// Audit 2026-06-13: the SendRawEmail path emitted no Destinations and kept bcc
	// out of the MIME → bcc recipients were silently dropped. They must be
	// delivered via Destinations while staying hidden from the MIME headers.
	it("SendRawEmail path delivers bcc via Destinations and keeps it out of the MIME", async () => {
		const t = new SesTransport(config);
		const msg = baseMessage();
		msg.cc = ["cc@example.com"];
		msg.bcc = ["secret@example.com"];
		msg.attachments = [
			{ filename: "x.pdf", content: "X", contentType: "application/pdf" },
		];
		await t.send(msg);

		const form = parseForm(requestBody(fetchSpy.mock.calls));
		expect(form.Action).toEqual(["SendRawEmail"]);
		const destinations = Object.entries(form)
			.filter(([k]) => k.startsWith("Destinations.member."))
			.flatMap(([, v]) => v);
		expect(destinations).toContain("user@example.com");
		expect(destinations).toContain("cc@example.com");
		expect(destinations).toContain("secret@example.com");
		// Bcc must never appear in the MIME (it stays hidden from other recipients).
		const mime = Buffer.from(
			form["RawMessage.Data"]?.[0] ?? "",
			"base64",
		).toString("utf8");
		expect(mime).not.toContain("secret@example.com");
	});

	it("adds SigV4 Authorization header scoped to ses/<region>", async () => {
		const t = new SesTransport({ ...config, region: "us-west-2" });
		await t.send(baseMessage());

		const auth = requestHeaders(fetchSpy.mock.calls).authorization;
		expect(auth).toMatch(/^AWS4-HMAC-SHA256 /);
		expect(auth).toContain("Credential=AKIA-TEST/");
		expect(auth).toContain("/us-west-2/ses/aws4_request");
		expect(auth).toContain("SignedHeaders=content-type;host;x-amz-date");
		expect(auth).toMatch(/Signature=[0-9a-f]+/);
	});

	it("strips CRLF from recipients, subject, reply-to in SendEmail form", async () => {
		const t = new SesTransport(config);
		const msg = baseMessage();
		msg.to = ["user@x.com\r\nX-Injected: evil"];
		msg.subject = "Hi\r\nBcc: victim@y.com";
		msg.replyTo = "reply@x.com\r\nEvil: yes";
		await t.send(msg);

		const form = parseForm(requestBody(fetchSpy.mock.calls));
		expect(form["Destination.ToAddresses.member.1"]).toEqual([
			"user@x.comX-Injected: evil",
		]);
		expect(form["Message.Subject.Data"]).toEqual(["HiBcc: victim@y.com"]);
		expect(form["ReplyToAddresses.member.1"]).toEqual(["reply@x.comEvil: yes"]);
	});

	it("throws E_MAIL_PROVIDER_ERROR on 400 with providerMessage", async () => {
		fetchSpy.mockResolvedValue(
			new Response(
				"<Error><Code>MessageRejected</Code><Message>Email address is not verified.</Message></Error>",
				{ status: 400 },
			),
		);
		const t = new SesTransport(config);

		await expect(t.send(baseMessage())).rejects.toMatchObject({
			code: "E_MAIL_PROVIDER_ERROR",
			context: {
				provider: "ses",
				upstreamStatus: "400",
			},
		});
	});

	it("throws RoverError on 5xx", async () => {
		fetchSpy.mockResolvedValue(new Response("boom", { status: 503 }));
		const t = new SesTransport(config);
		await expect(t.send(baseMessage())).rejects.toBeInstanceOf(RoverError);
	});

	it("returns { providerId } from SES <MessageId> XML response", async () => {
		fetchSpy.mockResolvedValue(
			new Response(
				"<SendEmailResponse><SendEmailResult><MessageId>0000012345-abcdef@us-east-1.amazonses.com</MessageId></SendEmailResult></SendEmailResponse>",
				{ status: 200 },
			),
		);
		const t = new SesTransport(config);
		const result = await t.send(baseMessage());
		expect(result).toEqual({
			providerId: "0000012345-abcdef@us-east-1.amazonses.com",
		});
	});

	it("throws config error when credentials or region missing", () => {
		expect(
			() => new SesTransport({ secretAccessKey: "s", region: "us-east-1" }),
		).toThrow("accessKeyId");
		expect(
			() => new SesTransport({ accessKeyId: "a", region: "us-east-1" }),
		).toThrow("secretAccessKey");
		expect(
			() => new SesTransport({ accessKeyId: "a", secretAccessKey: "s" }),
		).toThrow("region");
	});

	it("normalizes region (lowercases 'US-EAST-1', trims whitespace)", async () => {
		const t = new SesTransport({ ...config, region: " US-EAST-1 " });
		await t.send(baseMessage());
		expect(fetchSpy.mock.calls[0][0]).toBe(
			"https://email.us-east-1.amazonaws.com/",
		);
		const auth = requestHeaders(fetchSpy.mock.calls).authorization;
		expect(auth).toContain("/us-east-1/ses/aws4_request");
	});

	it("rejects invalid region shape (non-canonical)", () => {
		expect(
			() => new SesTransport({ ...config, region: "not a region!" }),
		).toThrow(/not a valid AWS region/);
	});

	it("trims CRLF from config secrets", async () => {
		const t = new SesTransport({
			accessKeyId: "AKIA-TEST\n",
			secretAccessKey: "secret\r\n",
			region: "us-east-1",
		});
		await t.send(baseMessage());
		const auth = requestHeaders(fetchSpy.mock.calls).authorization;
		expect(auth).toContain("Credential=AKIA-TEST/");
	});

	it("throws E_MAIL_PROVIDER_CONFIG when message has no recipients", async () => {
		const t = new SesTransport(config);
		const msg = baseMessage();
		msg.to = [];
		await expect(t.send(msg)).rejects.toMatchObject({
			code: "E_MAIL_PROVIDER_CONFIG",
		});
	});

	it("forces SendRawEmail when message carries custom headers (even without attachments)", async () => {
		const t = new SesTransport(config);
		const msg = baseMessage();
		msg.headers = { "X-Campaign-ID": "summer-2026" };
		await t.send(msg);

		const form = parseForm(fetchSpy.mock.calls[0][1]?.body as string);
		expect(form.Action).toEqual(["SendRawEmail"]);
		const rawB64 = form["RawMessage.Data"]?.[0] ?? "";
		const mime = Buffer.from(rawB64, "base64").toString("utf8");
		expect(mime).toContain("X-Campaign-ID: summer-2026");
	});

	it("emits multipart/alternative when both html and text are set (with attachments)", async () => {
		const t = new SesTransport(config);
		const msg = baseMessage();
		msg.attachments = [
			{ filename: "f.txt", content: "x", contentType: "text/plain" },
		];
		await t.send(msg);

		const form = parseForm(fetchSpy.mock.calls[0][1]?.body as string);
		const rawB64 = form["RawMessage.Data"]?.[0] ?? "";
		const mime = Buffer.from(rawB64, "base64").toString("utf8");
		expect(mime).toMatch(/Content-Type: multipart\/alternative/);
		expect(mime).toMatch(/Content-Type: text\/plain; charset=UTF-8/);
		expect(mime).toMatch(/Content-Type: text\/html; charset=UTF-8/);
		// Both bodies present
		expect(mime).toContain("Hi");
		expect(mime).toContain("<p>Hi</p>");
	});

	it('quote-escapes `"` and `\\` in attachment filenames (RFC 2183)', async () => {
		const t = new SesTransport(config);
		const msg = baseMessage();
		msg.attachments = [
			{
				filename: 'report"quoted.pdf',
				content: "x",
				contentType: "application/pdf",
			},
		];
		await t.send(msg);

		const form = parseForm(fetchSpy.mock.calls[0][1]?.body as string);
		const rawB64 = form["RawMessage.Data"]?.[0] ?? "";
		const mime = Buffer.from(rawB64, "base64").toString("utf8");
		expect(mime).toContain('filename="report\\"quoted.pdf"');
		expect(mime).toContain('name="report\\"quoted.pdf"');
	});

	it("captures Retry-After header in error context when set", async () => {
		fetchSpy.mockResolvedValue(
			new Response("throttled", {
				status: 429,
				headers: { "Retry-After": "5" },
			}),
		);
		const t = new SesTransport(config);
		await expect(t.send(baseMessage())).rejects.toMatchObject({
			context: { retryAfter: "5", upstreamStatus: "429" },
		});
	});

	it("redacts AWS Credential/Bearer echoes in providerMessage", async () => {
		fetchSpy.mockResolvedValue(
			new Response(
				"error: AWS4-HMAC-SHA256 Credential=AKIA-LEAKED/20260422/us-east-1/ses/aws4_request, SignedHeaders=...",
				{ status: 403 },
			),
		);
		const t = new SesTransport(config);
		await expect(t.send(baseMessage())).rejects.toMatchObject({
			context: {
				providerMessage: expect.stringContaining("AWS4-HMAC-SHA256 [REDACTED]"),
			},
		});
	});

	it("RFC 2047 encodes non-ASCII subject and addresses in raw MIME", async () => {
		const t = new SesTransport(config);
		const msg = baseMessage();
		msg.subject = "Café ☕ commandé";
		msg.from = "Üsér <sender@example.com>";
		msg.attachments = [
			{ filename: "f.txt", content: "x", contentType: "text/plain" },
		];
		await t.send(msg);

		const form = parseForm(fetchSpy.mock.calls[0][1]?.body as string);
		const rawB64 = form["RawMessage.Data"]?.[0] ?? "";
		const mime = Buffer.from(rawB64, "base64").toString("utf8");
		// Encoded-word wraps the value
		expect(mime).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
		expect(mime).toMatch(/From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
		// Round-trip: decode the encoded word and confirm original bytes
		const subjectMatch = mime.match(
			/Subject: =\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/,
		);
		expect(subjectMatch).not.toBeNull();
		expect(
			Buffer.from(subjectMatch?.[1] ?? "", "base64").toString("utf8"),
		).toBe("Café ☕ commandé");
	});

	it("leaves ASCII-only headers unencoded", async () => {
		const t = new SesTransport(config);
		const msg = baseMessage();
		msg.attachments = [
			{ filename: "f.txt", content: "x", contentType: "text/plain" },
		];
		await t.send(msg);

		const form = parseForm(fetchSpy.mock.calls[0][1]?.body as string);
		const rawB64 = form["RawMessage.Data"]?.[0] ?? "";
		const mime = Buffer.from(rawB64, "base64").toString("utf8");
		expect(mime).toContain("Subject: Hello");
		expect(mime).not.toMatch(/Subject: =\?UTF-8/);
	});

	it("SigV4 regression: stable signature for fixed credentials + fixed clock", async () => {
		// Lock a known date so the test doesn't depend on wall clock.
		vi.setSystemTime(new Date("2026-04-22T12:00:00.000Z"));
		try {
			const t = new SesTransport({
				accessKeyId: "AKIAIOSFODNN7EXAMPLE",
				secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
				region: "us-east-1",
			});
			const msg = baseMessage();
			await t.send(msg);

			const auth = requestHeaders(fetchSpy.mock.calls).authorization;
			// The full signature is deterministic given the inputs; lock it.
			expect(auth).toBe(
				"AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260422/us-east-1/ses/aws4_request, " +
					"SignedHeaders=content-type;host;x-amz-date, " +
					"Signature=92af0cac28a248a42899d60e2b0a875a1f1ab08f7b7fead50ac46a1304e52686",
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("boundary uses crypto-random hex (not Math.random)", async () => {
		const t = new SesTransport(config);
		const msg = baseMessage();
		msg.attachments = [
			{ filename: "a.txt", content: "x", contentType: "text/plain" },
		];
		await t.send(msg);

		const form = parseForm(fetchSpy.mock.calls[0][1]?.body as string);
		const rawB64 = form["RawMessage.Data"]?.[0] ?? "";
		const mime = Buffer.from(rawB64, "base64").toString("utf8");
		expect(mime).toMatch(/boundary="----ream_ses_[0-9a-f]{32}"/);
	});
});
