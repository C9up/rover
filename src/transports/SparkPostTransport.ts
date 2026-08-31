import { Buffer } from "node:buffer";
import {
	type MailMessage,
	type MailSendOutcome,
	type MailTransport,
	registerTransport,
} from "../Mail.js";
import { attachmentsFor, headerValue } from "../MessageBuilder.js";
import { RoverError } from "../RoverError.js";
import { fetchWithTimeout, wrapFetchNetworkError } from "./fetchError.js";

const stripCrlf = (v: string): string => v.replace(/[\r\n]/g, "");
const normalizeConfig = (v: string): string => stripCrlf(v).trim();
const MAX_PROVIDER_MESSAGE = 16 * 1024;
const capMessage = (s: string): string =>
	s.length <= MAX_PROVIDER_MESSAGE
		? s
		: `${s.slice(0, MAX_PROVIDER_MESSAGE)}...[truncated]`;
/** Redact Basic/Bearer tokens if the upstream echoes our own request headers. */
const redactSecrets = (s: string): string =>
	s
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
		.replace(/Basic\s+[A-Za-z0-9+/=]+/g, "Basic [REDACTED]");

interface SparkPostRecipient {
	address: { email: string; name?: string };
}

interface SparkPostBody {
	content: {
		from: string;
		subject: string;
		html?: string;
		text?: string;
		reply_to?: string;
		headers?: Record<string, string>;
		attachments?: Array<{ name: string; type: string; data: string }>;
	};
	recipients: SparkPostRecipient[];
}

/**
 * SparkPost transactional email transport. Talks to the `v1/transmissions`
 * REST API over `fetch`, mirroring the `@adonisjs/mail` SparkPost transport.
 * Same conventions as the other fetch-based transports (Resend / Brevo):
 * CRLF stripping at the wire boundary, secret redaction, `retry-after`
 * surfacing.
 */
export class SparkPostTransport implements MailTransport {
	#apiKey: string;
	#baseUrl: string;

	constructor(config: Record<string, unknown>) {
		const apiKey =
			typeof config.apiKey === "string"
				? normalizeConfig(config.apiKey)
				: typeof config.key === "string"
					? normalizeConfig(config.key)
					: "";
		if (!apiKey) {
			throw new RoverError(
				"E_MAIL_PROVIDER_CONFIG",
				"SparkPost transport requires apiKey",
				{ hint: "Set { apiKey } in your mail config." },
			);
		}
		this.#apiKey = apiKey;
		this.#baseUrl =
			typeof config.baseUrl === "string"
				? normalizeConfig(config.baseUrl).replace(/\/+$/, "")
				: "https://api.sparkpost.com";
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
		// SparkPost delivers to every address in `recipients`; cc/bcc are folded in
		// so they receive the message, and cc is surfaced via a `CC` header for
		// display (bcc stays hidden by design).
		const recipients: SparkPostRecipient[] = [
			...message.to,
			...message.cc,
			...message.bcc,
		].map((addr) => ({ address: parseAddress(addr) }));

		const body: SparkPostBody = {
			content: {
				from: stripCrlf(message.from),
				subject: stripCrlf(message.subject),
			},
			recipients,
		};
		if (message.html) body.content.html = message.html;
		if (message.text) body.content.text = message.text;
		if (message.replyTo) body.content.reply_to = stripCrlf(message.replyTo);
		const headers: Record<string, string> = {};
		for (const [k, raw] of Object.entries(message.headers)) {
			const v = headerValue(raw);
			headers[stripCrlf(k)] = Array.isArray(v)
				? v.map(stripCrlf).join(", ")
				: stripCrlf(v);
		}
		if (message.cc.length) headers.CC = message.cc.map(stripCrlf).join(", ");
		if (Object.keys(headers).length > 0) body.content.headers = headers;
		if (attachmentsFor(message).length > 0) {
			body.content.attachments = attachmentsFor(message).map((att) => ({
				name: stripCrlf(att.filename),
				type: att.contentType
					? stripCrlf(att.contentType)
					: "application/octet-stream",
				data: Buffer.from(att.content as Buffer | string).toString("base64"),
			}));
		}

		let res: Response;
		try {
			res = await fetchWithTimeout(
				"SparkPost",
				`${this.#baseUrl}/api/v1/transmissions`,
				{
					method: "POST",
					headers: {
						Authorization: this.#apiKey,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
				},
			);
		} catch (err) {
			throw wrapFetchNetworkError("sparkpost", err);
		}
		if (!res.ok) {
			const providerMessage = redactSecrets(capMessage(await res.text()));
			const retryAfter = res.headers.get("retry-after") ?? undefined;
			const ctx: Record<string, string> = {
				provider: "sparkpost",
				upstreamStatus: String(res.status),
				providerMessage,
			};
			if (retryAfter) ctx.retryAfter = retryAfter;
			throw new RoverError(
				"E_MAIL_PROVIDER_ERROR",
				`SparkPost returned ${res.status}`,
				{
					hint: "Inspect `context.upstreamStatus` to decide retry eligibility. `context.retryAfter` (when set) carries the provider's backoff hint in seconds.",
					context: ctx,
				},
			);
		}
		// Success: SparkPost returns `{ results: { id: "<id>", ... } }`.
		try {
			const parsed = (await res.json()) as { results?: { id?: string } };
			const id = parsed.results?.id;
			if (typeof id === "string" && id.length > 0) {
				return { providerId: id };
			}
		} catch {
			// Empty / non-JSON body — fall back to generated id.
		}
		return undefined;
	}
}

/**
 * Split a possibly-formatted address (`"Name" <addr>` / `Name <addr>` / bare
 * `addr`) into SparkPost's `{ email, name? }` address shape.
 */
function parseAddress(input: string): { email: string; name?: string } {
	const s = stripCrlf(input).trim();
	const match = s.match(/^(.*)<([^>]+)>\s*$/);
	if (match) {
		const email = match[2].trim();
		const name = match[1].trim().replace(/^"|"$/g, "").trim();
		return name ? { email, name } : { email };
	}
	return { email: s };
}

registerTransport("sparkpost", (config) => new SparkPostTransport(config));
