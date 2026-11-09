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

interface SparkPostBody {
	/** RFC 822 content: the MIME as nodemailer composes it for SMTP. */
	content: { email_rfc822: string };
	/** Who it is delivered to — the envelope, bcc included. */
	recipients: Array<{ address: { email: string } }>;
	/** The envelope sender (bounce address), when the caller set one. */
	return_path?: string;
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
		// `email_rfc822`, as the upstream SparkPost transport sends it: threading
		// headers, priority, inline cid parts, the watch body and List-* travel
		// as they would over SMTP, and Bcc stays out of the headers while the
		// recipient list still delivers to it.
		const composed = await composeMime(message);
		const body: SparkPostBody = {
			content: { email_rfc822: composed.raw.toString("utf8") },
			recipients: composed.envelope.to.map((email) => ({
				address: { email },
			})),
		};
		if (message.envelope?.from !== undefined && composed.envelope.from) {
			body.return_path = composed.envelope.from;
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
			const parsed: unknown = await res.json();
			const results =
				typeof parsed === "object" && parsed !== null
					? Reflect.get(parsed, "results")
					: undefined;
			const id =
				typeof results === "object" && results !== null
					? Reflect.get(results, "id")
					: undefined;
			if (typeof id === "string" && id.length > 0) {
				return { providerId: id, envelope: composed.envelope };
			}
		} catch {
			// Empty / non-JSON body — fall back to generated id.
		}
		return { envelope: composed.envelope };
	}
}

registerTransport("sparkpost", (config) => new SparkPostTransport(config));
