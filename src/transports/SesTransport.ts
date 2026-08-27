import { Buffer } from "node:buffer";
import { createHash, createHmac, randomBytes } from "node:crypto";
import {
	type MailAttachment,
	type MailMessage,
	type MailSendOutcome,
	type MailTransport,
	registerTransport,
} from "../Mail.js";
import { attachmentsFor } from "../MessageBuilder.js";
import { RoverError } from "../RoverError.js";
import { fetchWithTimeout, wrapFetchNetworkError } from "./fetchError.js";

const stripCrlf = (v: string): string => v.replace(/[\r\n]/g, "");
const normalizeConfig = (v: string): string => stripCrlf(v).trim();
/** RFC 2183: quote `"` and `\` inside filename="..." / name="..." parameters. */
const mimeQuote = (v: string): string =>
	stripCrlf(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
/**
 * RFC 2047 encoded-word wrapping for non-ASCII header values.
 * Returns the input as-is when it contains only ASCII; otherwise returns a
 * base64 encoded-word (`=?UTF-8?B?...?=`). Safe for Subject, From, To display
 * names, etc. — raw 8-bit in headers is non-conformant under RFC 5322.
 */
function encodeHeaderWord(v: string): string {
	const stripped = stripCrlf(v);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching non-ASCII explicitly (any byte > 0x7F is non-ASCII)
	if (!/[^\x00-\x7F]/.test(stripped)) return stripped;
	const b64 = Buffer.from(stripped, "utf8").toString("base64");
	return `=?UTF-8?B?${b64}?=`;
}
const REGION_RE = /^[a-z0-9-]+$/;
const MAX_PROVIDER_MESSAGE = 16 * 1024;
const capMessage = (s: string): string =>
	s.length <= MAX_PROVIDER_MESSAGE
		? s
		: `${s.slice(0, MAX_PROVIDER_MESSAGE)}...[truncated]`;
/** Redact Basic/Bearer tokens if the upstream echoes our own request headers. */
const redactSecrets = (s: string): string =>
	s
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
		.replace(
			/AWS4-HMAC-SHA256\s+Credential=[^,]+/g,
			"AWS4-HMAC-SHA256 [REDACTED]",
		);

export class SesTransport implements MailTransport {
	#accessKeyId: string;
	#secretAccessKey: string;
	#region: string;
	#host: string;

	constructor(config: Record<string, unknown>) {
		const accessKeyId =
			typeof config.accessKeyId === "string"
				? normalizeConfig(config.accessKeyId)
				: "";
		const secretAccessKey =
			typeof config.secretAccessKey === "string"
				? normalizeConfig(config.secretAccessKey)
				: "";
		const rawRegion =
			typeof config.region === "string"
				? normalizeConfig(config.region).toLowerCase()
				: "";
		if (!accessKeyId || !secretAccessKey || !rawRegion) {
			throw new RoverError(
				"MAIL_PROVIDER_CONFIG",
				"SES transport requires accessKeyId, secretAccessKey, and region",
				{ hint: "Set all three in your mail config." },
			);
		}
		if (!REGION_RE.test(rawRegion)) {
			throw new RoverError(
				"MAIL_PROVIDER_CONFIG",
				`SES region "${rawRegion}" is not a valid AWS region identifier`,
				{
					hint: "Use the lowercase canonical form, e.g. 'us-east-1'. Uppercase breaks the SigV4 signing scope.",
				},
			);
		}
		this.#accessKeyId = accessKeyId;
		this.#secretAccessKey = secretAccessKey;
		this.#region = rawRegion;
		this.#host = `email.${rawRegion}.amazonaws.com`;
	}

	async send(message: MailMessage): Promise<MailSendOutcome> {
		if (
			message.to.length === 0 &&
			message.cc.length === 0 &&
			message.bcc.length === 0
		) {
			throw new RoverError(
				"MAIL_PROVIDER_CONFIG",
				"Mail message has no recipients",
				{ hint: "Set at least one `to`, `cc`, or `bcc` before sending." },
			);
		}

		// Custom headers are only honoured on the SendRawEmail path (where we
		// compose the MIME ourselves), so flip to raw whenever the message
		// carries headers, even without attachments.
		const useRaw =
			attachmentsFor(message).length > 0 ||
			Object.keys(message.headers).length > 0;
		const form = useRaw
			? buildRawEmailForm(message)
			: buildSendEmailForm(message);

		const url = `https://${this.#host}/`;
		const headers = this.#signRequest("POST", form);
		// Same network-error wrap as ResendTransport — see retry.ts for
		// why undici's `cause.code` matters for retry classification.
		let res: Response;
		try {
			res = await fetchWithTimeout("SES", url, {
				method: "POST",
				headers,
				body: form,
			});
		} catch (err) {
			throw wrapFetchNetworkError("ses", err);
		}
		if (!res.ok) {
			const providerMessage = redactSecrets(capMessage(await res.text()));
			const retryAfter = res.headers.get("retry-after") ?? undefined;
			const ctx: Record<string, string> = {
				provider: "ses",
				upstreamStatus: String(res.status),
				providerMessage,
			};
			if (retryAfter) ctx.retryAfter = retryAfter;
			throw new RoverError(
				"MAIL_PROVIDER_ERROR",
				`SES returned ${res.status}`,
				{
					hint: "Inspect `context.upstreamStatus` to decide retry eligibility. `context.retryAfter` (when set) carries the provider's backoff hint in seconds.",
					context: ctx,
				},
			);
		}
		// SES XML success shape: <SendEmailResponse><SendEmailResult><MessageId>...
		// or <SendRawEmailResult><MessageId>... — extract via a scoped regex.
		try {
			const xml = await res.text();
			const match = xml.match(/<MessageId>([^<]+)<\/MessageId>/);
			if (match?.[1]) return { providerId: match[1] };
		} catch {
			// Network truncation on success response is rare; fall back to generated id.
		}
		return;
	}

	/** SigV4 header signer, scoped to `ses`. Canonical request: POST / with form body. */
	#signRequest(method: string, body: string): Record<string, string> {
		const dateStamp = amzDateNow();
		const shortDate = dateStamp.slice(0, 8);
		const service = "ses";
		const payloadHash = createHash("sha256").update(body).digest("hex");

		const headers: Record<string, string> = {
			host: this.#host,
			"x-amz-date": dateStamp,
			"content-type": "application/x-www-form-urlencoded",
		};
		const sortedKeys = Object.keys(headers).sort();
		const signedHeaders = sortedKeys.join(";");
		const canonicalHeaders = sortedKeys
			.map((k) => `${k}:${headers[k]}\n`)
			.join("");
		const canonicalRequest = [
			method,
			"/",
			"",
			canonicalHeaders,
			signedHeaders,
			payloadHash,
		].join("\n");

		const scope = `${shortDate}/${this.#region}/${service}/aws4_request`;
		const stringToSign = [
			"AWS4-HMAC-SHA256",
			dateStamp,
			scope,
			createHash("sha256").update(canonicalRequest).digest("hex"),
		].join("\n");

		const signingKey = deriveSigningKey(
			this.#secretAccessKey,
			shortDate,
			this.#region,
			service,
		);
		const signature = createHmac("sha256", signingKey)
			.update(stringToSign)
			.digest("hex");

		headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.#accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
		return headers;
	}
}

function buildSendEmailForm(message: MailMessage): string {
	const params: Array<[string, string]> = [];
	params.push(["Action", "SendEmail"]);
	params.push(["Source", stripCrlf(message.from)]);
	message.to.forEach((addr, i) => {
		params.push([`Destination.ToAddresses.member.${i + 1}`, stripCrlf(addr)]);
	});
	message.cc.forEach((addr, i) => {
		params.push([`Destination.CcAddresses.member.${i + 1}`, stripCrlf(addr)]);
	});
	message.bcc.forEach((addr, i) => {
		params.push([`Destination.BccAddresses.member.${i + 1}`, stripCrlf(addr)]);
	});
	if (message.replyTo) {
		params.push(["ReplyToAddresses.member.1", stripCrlf(message.replyTo)]);
	}
	params.push(["Message.Subject.Data", stripCrlf(message.subject)]);
	params.push(["Message.Subject.Charset", "UTF-8"]);
	if (message.html) {
		params.push(["Message.Body.Html.Data", message.html]);
		params.push(["Message.Body.Html.Charset", "UTF-8"]);
	}
	if (message.text) {
		params.push(["Message.Body.Text.Data", message.text]);
		params.push(["Message.Body.Text.Charset", "UTF-8"]);
	}
	return params
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join("&");
}

function buildRawEmailForm(message: MailMessage): string {
	const raw = buildRawMime(message);
	const b64 = Buffer.from(raw).toString("base64");
	// Targeted URL-escape: base64's alphabet is URL-safe *except* for `+` / `/`
	// and the trailing `=` padding. Replacing only those three avoids walking
	// the entire string character-by-character the way encodeURIComponent does.
	const urlEncoded = b64.replace(/[+/=]/g, (c) =>
		c === "+" ? "%2B" : c === "/" ? "%2F" : "%3D",
	);
	const parts = ["Action=SendRawEmail", `RawMessage.Data=${urlEncoded}`];
	// SendRawEmail only delivers to addresses in the MIME headers UNLESS
	// Destinations is supplied. Bcc is deliberately kept out of the MIME (it must
	// stay hidden), so when there are bcc recipients we MUST enumerate every
	// recipient (to + cc + bcc) as Destinations — otherwise bcc is silently
	// dropped. No bcc → leave delivery to header parsing (unchanged).
	if (message.bcc.length > 0) {
		const recipients = [...message.to, ...message.cc, ...message.bcc];
		recipients.forEach((addr, i) => {
			parts.push(
				`Destinations.member.${i + 1}=${encodeURIComponent(stripCrlf(addr))}`,
			);
		});
	}
	return parts.join("&");
}

function buildRawMime(message: MailMessage): string {
	const parts: string[] = [];
	parts.push(`From: ${encodeHeaderWord(message.from)}`);
	parts.push(`To: ${message.to.map(encodeHeaderWord).join(", ")}`);
	if (message.cc.length) {
		parts.push(`Cc: ${message.cc.map(encodeHeaderWord).join(", ")}`);
	}
	if (message.replyTo)
		parts.push(`Reply-To: ${encodeHeaderWord(message.replyTo)}`);
	parts.push(`Subject: ${encodeHeaderWord(message.subject)}`);
	parts.push("MIME-Version: 1.0");
	const reserved = new Set([
		"from",
		"to",
		"cc",
		"bcc",
		"subject",
		"reply-to",
		"mime-version",
		"content-type",
		"content-transfer-encoding",
		"content-disposition",
	]);
	for (const [k, raw] of Object.entries(message.headers)) {
		if (reserved.has(k.toLowerCase())) continue;
		// A PREPARED header is the one case the flag actually decides: this
		// builds raw MIME, and re-encoding a value that is already exactly what
		// must go on the wire — a signature, a pre-encoded id — corrupts it.
		if (!Array.isArray(raw) && typeof raw !== "string") {
			parts.push(`${stripCrlf(k)}: ${stripCrlf(raw.value)}`);
			continue;
		}
		parts.push(
			`${stripCrlf(k)}: ${encodeHeaderWord(Array.isArray(raw) ? raw.join(", ") : raw)}`,
		);
	}

	const hasAttachments = attachmentsFor(message).length > 0;
	const mixedBoundary = freshBoundary();

	if (hasAttachments) {
		parts.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
		parts.push("");
		parts.push(`--${mixedBoundary}`);
		appendBodyBlock(parts, message);
		for (const att of attachmentsFor(message)) {
			appendAttachmentPart(parts, mixedBoundary, att);
		}
		parts.push(`--${mixedBoundary}--`);
	} else {
		appendBodyHeadersInline(parts, message);
	}
	return parts.join("\r\n");
}

/**
 * Emit the body block for the `multipart/mixed` first part. Handles three cases:
 *   - both html and text set → `multipart/alternative` wrapping both
 *   - html only → bare `text/html` part
 *   - text only → bare `text/plain` part
 *   - neither → bare `text/plain` empty part (keeps MIME valid when attachments only)
 */
function appendBodyBlock(parts: string[], message: MailMessage): void {
	if (message.html && message.text) {
		const altBoundary = freshBoundary();
		parts.push(
			`Content-Type: multipart/alternative; boundary="${altBoundary}"`,
		);
		parts.push("");
		parts.push(`--${altBoundary}`);
		parts.push("Content-Type: text/plain; charset=UTF-8");
		parts.push("");
		parts.push(message.text);
		parts.push(`--${altBoundary}`);
		parts.push("Content-Type: text/html; charset=UTF-8");
		parts.push("");
		parts.push(message.html);
		parts.push(`--${altBoundary}--`);
	} else if (message.html) {
		parts.push("Content-Type: text/html; charset=UTF-8");
		parts.push("");
		parts.push(message.html);
	} else if (message.text) {
		parts.push("Content-Type: text/plain; charset=UTF-8");
		parts.push("");
		parts.push(message.text);
	} else {
		parts.push("Content-Type: text/plain; charset=UTF-8");
		parts.push("");
		parts.push("");
	}
}

/** No-attachment variant: pack body headers straight onto the outer message. */
function appendBodyHeadersInline(parts: string[], message: MailMessage): void {
	if (message.html && message.text) {
		const altBoundary = freshBoundary();
		parts.push(
			`Content-Type: multipart/alternative; boundary="${altBoundary}"`,
		);
		parts.push("");
		parts.push(`--${altBoundary}`);
		parts.push("Content-Type: text/plain; charset=UTF-8");
		parts.push("");
		parts.push(message.text);
		parts.push(`--${altBoundary}`);
		parts.push("Content-Type: text/html; charset=UTF-8");
		parts.push("");
		parts.push(message.html);
		parts.push(`--${altBoundary}--`);
	} else if (message.html) {
		parts.push("Content-Type: text/html; charset=UTF-8");
		parts.push("");
		parts.push(message.html);
	} else {
		parts.push("Content-Type: text/plain; charset=UTF-8");
		parts.push("");
		parts.push(message.text ?? "");
	}
}

function appendAttachmentPart(
	parts: string[],
	boundary: string,
	att: MailAttachment,
): void {
	parts.push(`--${boundary}`);
	const contentType = stripCrlf(att.contentType ?? "application/octet-stream");
	const quotedName = mimeQuote(att.filename);
	parts.push(`Content-Type: ${contentType}; name="${quotedName}"`);
	parts.push("Content-Transfer-Encoding: base64");
	parts.push(`Content-Disposition: attachment; filename="${quotedName}"`);
	parts.push("");
	const buf = Buffer.from(att.content as Buffer | string);
	const raw64 = buf.toString("base64");
	for (let i = 0; i < raw64.length; i += 76) {
		parts.push(raw64.slice(i, i + 76));
	}
}

function freshBoundary(): string {
	return `----ream_ses_${randomBytes(16).toString("hex")}`;
}

function amzDateNow(): string {
	return `${new Date().toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
}

function deriveSigningKey(
	secret: string,
	shortDate: string,
	region: string,
	service: string,
): Buffer {
	const kDate = createHmac("sha256", `AWS4${secret}`)
		.update(shortDate)
		.digest();
	const kRegion = createHmac("sha256", kDate).update(region).digest();
	const kService = createHmac("sha256", kRegion).update(service).digest();
	return createHmac("sha256", kService).update("aws4_request").digest();
}

registerTransport("ses", (config) => new SesTransport(config));
