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

interface BrevoContact {
	email: string;
	name?: string;
}

interface BrevoBody {
	sender: BrevoContact;
	to: BrevoContact[];
	cc?: BrevoContact[];
	bcc?: BrevoContact[];
	replyTo?: BrevoContact;
	subject: string;
	htmlContent?: string;
	textContent?: string;
	headers?: Record<string, string>;
	attachment?: Array<{ name: string; content: string }>;
}

/**
 * Brevo (formerly Sendinblue) transactional email transport. Talks to the
 * `v3/smtp/email` REST API over `fetch`, mirroring the `@adonisjs/mail` Brevo
 * transport. Same conventions as the other fetch-based transports (Resend /
 * SES): CRLF stripping at the wire boundary, secret redaction, `retry-after`
 * surfacing.
 */
export class BrevoTransport implements MailTransport {
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
				"Brevo transport requires apiKey",
				{ hint: "Set { apiKey } in your mail config." },
			);
		}
		this.#apiKey = apiKey;
		this.#baseUrl =
			typeof config.baseUrl === "string"
				? normalizeConfig(config.baseUrl).replace(/\/+$/, "")
				: "https://api.brevo.com";
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
		const body: BrevoBody = {
			sender: parseContact(message.from),
			to: (message.to.length > 0 ? message.to : [message.from]).map(
				parseContact,
			),
			subject: stripCrlf(message.subject),
		};
		if (message.cc.length) body.cc = message.cc.map(parseContact);
		if (message.bcc.length) body.bcc = message.bcc.map(parseContact);
		if (message.replyTo) body.replyTo = parseContact(message.replyTo);
		if (message.html) body.htmlContent = message.html;
		if (message.text) body.textContent = message.text;
		const customHeaders = Object.entries(message.headers);
		if (customHeaders.length > 0) {
			body.headers = {};
			for (const [k, raw] of customHeaders) {
				const v = headerValue(raw);
				body.headers[stripCrlf(k)] = Array.isArray(v)
					? v.map(stripCrlf).join(", ")
					: stripCrlf(v);
			}
		}
		if (attachmentsFor(message).length > 0) {
			body.attachment = attachmentsFor(message).map((att) => ({
				name: stripCrlf(att.filename),
				content: Buffer.from(att.content as Buffer | string).toString("base64"),
			}));
		}

		let res: Response;
		try {
			res = await fetchWithTimeout("Brevo", `${this.#baseUrl}/v3/smtp/email`, {
				method: "POST",
				headers: {
					"api-key": this.#apiKey,
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify(body),
			});
		} catch (err) {
			throw wrapFetchNetworkError("brevo", err);
		}
		if (!res.ok) {
			const providerMessage = redactSecrets(capMessage(await res.text()));
			const retryAfter = res.headers.get("retry-after") ?? undefined;
			const ctx: Record<string, string> = {
				provider: "brevo",
				upstreamStatus: String(res.status),
				providerMessage,
			};
			if (retryAfter) ctx.retryAfter = retryAfter;
			throw new RoverError(
				"E_MAIL_PROVIDER_ERROR",
				`Brevo returned ${res.status}`,
				{
					hint: "Inspect `context.upstreamStatus` to decide retry eligibility. `context.retryAfter` (when set) carries the provider's backoff hint in seconds.",
					context: ctx,
				},
			);
		}
		// Success: Brevo returns `{ messageId: "<id>" }`.
		try {
			const parsed = (await res.json()) as { messageId?: string };
			if (typeof parsed.messageId === "string" && parsed.messageId.length > 0) {
				return { providerId: parsed.messageId };
			}
		} catch {
			// Empty / non-JSON body — fall back to generated id.
		}
		return undefined;
	}
}

/**
 * Split a possibly-formatted address (`"Name" <addr>` / `Name <addr>` / bare
 * `addr`) into Brevo's `{ email, name? }` contact shape.
 */
function parseContact(input: string): BrevoContact {
	const s = stripCrlf(input).trim();
	const match = s.match(/^(.*)<([^>]+)>\s*$/);
	// Both groups are required by the pattern, so a match carries both —
	// named rather than indexed, which is what says so.
	const [, rawName, rawEmail] = match ?? [];
	if (rawEmail !== undefined) {
		const email = rawEmail.trim();
		const name = (rawName ?? "").trim().replace(/^"|"$/g, "").trim();
		return name ? { email, name } : { email };
	}
	return { email: s };
}

registerTransport("brevo", (config) => new BrevoTransport(config));
