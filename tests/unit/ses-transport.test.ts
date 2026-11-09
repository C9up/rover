import { Buffer } from "node:buffer";
import { createHash, createHmac } from "node:crypto";
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

const rawMime = (form: Record<string, string[]>): string =>
	Buffer.from(form["RawMessage.Data"]?.[0] ?? "", "base64").toString("utf8");

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

	it("always sends SendRawEmail, recipients as Destinations", async () => {
		const t = new SesTransport(config);
		const msg = baseMessage();
		msg.cc = ["cc@example.com"];
		msg.replyTo = ["reply@example.com"];
		await t.send(msg);

		const form = parseForm(requestBody(fetchSpy.mock.calls));
		expect(form.Action).toEqual(["SendRawEmail"]);
		expect(form.Source).toBeUndefined();
		expect(form["Destinations.member.1"]).toEqual(["user@example.com"]);
		expect(form["Destinations.member.2"]).toEqual(["cc@example.com"]);
		const mime = rawMime(form);
		expect(mime).toMatch(/^From: sender@example.com\r$/m);
		expect(mime).toMatch(/^Cc: cc@example.com\r$/m);
		expect(mime).toMatch(/^Reply-To: reply@example.com\r$/m);
		expect(mime).toMatch(/^Subject: Hello\r$/m);
	});

	it("carries attachments in the MIME", async () => {
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

		const mime = rawMime(parseForm(requestBody(fetchSpy.mock.calls)));
		expect(mime).toContain("Content-Disposition: attachment");
		expect(mime).toContain("filename=invoice.pdf");
		expect(mime).toContain(Buffer.from("PDFBYTES").toString("base64"));
	});

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

	it("keeps line breaks in the subject from opening a header", async () => {
		const t = new SesTransport(config);
		const msg = baseMessage();
		msg.subject = "Hi\r\nBcc: victim@y.com";
		await t.send(msg);

		const mime = rawMime(parseForm(requestBody(fetchSpy.mock.calls)));
		expect(mime).not.toMatch(/^Bcc:/im);
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
				"<SendRawEmailResponse><SendRawEmailResult><MessageId>0000012345-abcdef@us-east-1.amazonses.com</MessageId></SendRawEmailResult></SendRawEmailResponse>",
				{ status: 200 },
			),
		);
		const t = new SesTransport(config);
		const result = await t.send(baseMessage());
		expect(result?.providerId).toBe(
			"0000012345-abcdef@us-east-1.amazonses.com",
		);
		expect(result?.envelope).toEqual({
			from: "sender@example.com",
			to: ["user@example.com"],
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

		const mime = rawMime(parseForm(requestBody(fetchSpy.mock.calls)));
		expect(mime).toMatch(/Content-Type: multipart\/alternative/);
		expect(mime).toMatch(/Content-Type: text\/plain; charset=utf-8/);
		expect(mime).toMatch(/Content-Type: text\/html; charset=utf-8/);
		expect(mime).toContain("<p>Hi</p>");
	});

	it('encodes a `"` in an attachment filename instead of closing the parameter', async () => {
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

		const mime = rawMime(parseForm(requestBody(fetchSpy.mock.calls)));
		// RFC 2231 parameter encoding: the quote travels as %22.
		expect(mime).toContain("filename*0*=utf-8''report%22quoted.pdf");
		expect(mime).not.toContain('report"quoted');
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

	it("encodes only the display name, never the address (RFC 2047 §5)", async () => {
		const t = new SesTransport(config);
		const msg = baseMessage();
		msg.subject = "Café ☕ commandé";
		msg.from = { address: "app@example.com", name: "Zoë Corp" };
		await t.send(msg);

		const mime = rawMime(parseForm(requestBody(fetchSpy.mock.calls)));
		const from = mime.match(/^From: (.+)\r$/m)?.[1] ?? "";
		expect(from).toMatch(/^=\?UTF-8\?[QB]\?.+\?= <app@example\.com>$/);
		expect(mime).toMatch(/^Subject: =\?UTF-8\?/m);
	});

	it("produces conformant MIME: CRLF only, lines within 998, encoded bodies", async () => {
		const t = new SesTransport(config);
		const msg = baseMessage();
		msg.html = `<p>${"x".repeat(1500)}</p>`;
		msg.text = "héllo\nbare-lf\rbare-cr";
		msg.headers = { "X-Custom": "1" };
		await t.send(msg);

		const mime = rawMime(parseForm(requestBody(fetchSpy.mock.calls)));
		expect(mime).not.toMatch(/\r(?!\n)/);
		expect(mime).not.toMatch(/(?<!\r)\n/);
		for (const line of mime.split("\r\n")) {
			expect(line.length).toBeLessThanOrEqual(998);
		}
		expect(mime).toMatch(
			/Content-Transfer-Encoding: (quoted-printable|base64)/,
		);
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

	it("SigV4: the signature matches an independent computation over the body sent", async () => {
		vi.setSystemTime(new Date("2026-04-22T12:00:00.000Z"));
		try {
			const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
			const t = new SesTransport({
				accessKeyId: "AKIAIOSFODNN7EXAMPLE",
				secretAccessKey: secret,
				region: "us-east-1",
			});
			await t.send(baseMessage());

			const body = requestBody(fetchSpy.mock.calls);
			const sha = (v: string) => createHash("sha256").update(v).digest("hex");
			const hmac = (key: string | Buffer, v: string) =>
				createHmac("sha256", key).update(v).digest();
			const canonical = [
				"POST",
				"/",
				"",
				"content-type:application/x-www-form-urlencoded\nhost:email.us-east-1.amazonaws.com\nx-amz-date:20260422T120000Z\n",
				"content-type;host;x-amz-date",
				sha(body),
			].join("\n");
			const toSign = [
				"AWS4-HMAC-SHA256",
				"20260422T120000Z",
				"20260422/us-east-1/ses/aws4_request",
				sha(canonical),
			].join("\n");
			const key = hmac(
				hmac(hmac(hmac(`AWS4${secret}`, "20260422"), "us-east-1"), "ses"),
				"aws4_request",
			);
			const signature = createHmac("sha256", key).update(toSign).digest("hex");
			expect(requestHeaders(fetchSpy.mock.calls).authorization).toBe(
				"AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260422/us-east-1/ses/aws4_request, " +
					`SignedHeaders=content-type;host;x-amz-date, Signature=${signature}`,
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("passes the envelope as Source and Destinations", async () => {
		const t = new SesTransport(config);
		const msg = baseMessage();
		msg.envelope = { from: "bounce@example.com", to: "env-only@example.com" };
		await t.send(msg);

		const form = parseForm(requestBody(fetchSpy.mock.calls));
		expect(form.Source).toEqual(["bounce@example.com"]);
		expect(form["Destinations.member.1"]).toEqual(["env-only@example.com"]);
		expect(form["Destinations.member.2"]).toBeUndefined();
	});
});
