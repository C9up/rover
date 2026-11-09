import { createHash, createHmac } from "node:crypto";
import {
	type MailMessage,
	type MailSendOutcome,
	type MailTransport,
	registerTransport,
} from "../Mail.js";
import { composeMime } from "../mime.js";
import { RoverError } from "../RoverError.js";
import { fetchWithTimeout, wrapFetchNetworkError } from "./fetchError.js";

const stripCrlf = (v: string): string => v.replace(/[\r\n]/g, "");
const normalizeConfig = (v: string): string => stripCrlf(v).trim();
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
				"E_MAIL_PROVIDER_CONFIG",
				"SES transport requires accessKeyId, secretAccessKey, and region",
				{ hint: "Set all three in your mail config." },
			);
		}
		if (!REGION_RE.test(rawRegion)) {
			throw new RoverError(
				"E_MAIL_PROVIDER_CONFIG",
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
				"E_MAIL_PROVIDER_CONFIG",
				"Mail message has no recipients",
				{ hint: "Set at least one `to`, `cc`, or `bcc` before sending." },
			);
		}

		// Always SendRawEmail, with MIME composed by nodemailer as the SMTP
		// transport would send it: encoded-words only around display names,
		// transfer-encoded bodies, folded lines, inline parts, threading
		// headers. The envelope travels as Source (bounce address) and
		// Destinations, which is also how bcc recipients get delivered
		// without a Bcc header in the MIME.
		const composed = await composeMime(message);
		const form = rawEmailForm(composed.raw, composed.envelope, message);

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
				"E_MAIL_PROVIDER_ERROR",
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
			if (match?.[1]) {
				return { providerId: match[1], envelope: composed.envelope };
			}
		} catch {
			// Network truncation on success response is rare; fall back to generated id.
		}
		return { envelope: composed.envelope };
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

/** The SendRawEmail form: the MIME, the bounce address and the recipients. */
function rawEmailForm(
	raw: Buffer,
	envelope: { from: string | false; to: string[] },
	message: MailMessage,
): string {
	const params: Array<[string, string]> = [
		["Action", "SendRawEmail"],
		["RawMessage.Data", raw.toString("base64")],
	];
	// Source is the envelope sender; only set when the caller chose one, so
	// SES otherwise keeps deriving it from the From header as before.
	if (message.envelope?.from !== undefined && envelope.from !== false) {
		params.push(["Source", envelope.from]);
	}
	envelope.to.forEach((address, i) => {
		params.push([`Destinations.member.${i + 1}`, address]);
	});
	return params
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join("&");
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
