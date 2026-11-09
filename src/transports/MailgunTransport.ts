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

const redactSecrets = (s: string): string =>
	s
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
		.replace(/Basic\s+[A-Za-z0-9+/=]+/g, "Basic [REDACTED]");

export class MailgunTransport implements MailTransport {
	#apiKey: string;
	#domain: string;
	#baseUrl: string;

	constructor(config: Record<string, unknown>) {
		const apiKey =
			typeof config.apiKey === "string" ? normalizeConfig(config.apiKey) : "";
		const domain =
			typeof config.domain === "string" ? normalizeConfig(config.domain) : "";
		if (!apiKey || !domain) {
			throw new RoverError(
				"E_MAIL_PROVIDER_CONFIG",
				"Mailgun transport requires apiKey and domain",
				{ hint: "Set { apiKey, domain } in your mail config." },
			);
		}
		this.#domain = domain;

		// Region: reject non-string when *defined* (wrong type signals a config
		// bug — defaulting to "us" under those conditions is a compliance risk).
		if (config.region !== undefined && typeof config.region !== "string") {
			throw new RoverError(
				"E_MAIL_PROVIDER_CONFIG",
				`Mailgun region must be a string ("us" or "eu"), got ${typeof config.region}`,
				{ hint: "Set config.region explicitly as 'us' or 'eu'." },
			);
		}
		const rawRegion =
			typeof config.region === "string"
				? normalizeConfig(config.region).toLowerCase()
				: "us";
		if (rawRegion !== "us" && rawRegion !== "eu") {
			throw new RoverError(
				"E_MAIL_PROVIDER_CONFIG",
				`Mailgun region must be "us" or "eu", got "${rawRegion}"`,
				{
					hint: "Use { region: 'us' } or { region: 'eu' }. A typo silently routing EU traffic to US infrastructure is a compliance risk.",
				},
			);
		}
		const url =
			rawRegion === "eu"
				? "https://api.eu.mailgun.net"
				: "https://api.mailgun.net";

		this.#apiKey = apiKey;
		this.#baseUrl =
			typeof config.baseUrl === "string" && config.baseUrl.length > 0
				? normalizeConfig(config.baseUrl).replace(/\/+$/, "")
				: url;
	}

	async send(message: MailMessage): Promise<MailSendOutcome> {
		if (message.envelope?.from !== undefined) {
			throw new RoverError(
				"E_MAIL_FIELD_UNSUPPORTED",
				"The mailgun transport cannot set the envelope sender; Mailgun uses the domain's own bounce address.",
				{
					hint: "Send this message through an SMTP mailer, or drop envelope().from.",
					context: { provider: "mailgun", field: "envelope" },
				},
			);
		}
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

		// `messages.mime`: the message as nodemailer composes it for SMTP, so
		// Message-ID, In-Reply-To, References, priority, inline cid parts, the
		// watch body and List-* all arrive as they would over SMTP. `to` is the
		// delivery list (the envelope), Bcc being absent from the MIME.
		const composed = await composeMime(message);
		const form = new FormData();
		for (const address of composed.envelope.to) form.append("to", address);
		form.append(
			"message",
			new Blob([new Uint8Array(composed.raw)], { type: "message/rfc822" }),
			"message.mime",
		);

		let res: Response;
		try {
			res = await fetchWithTimeout(
				"Mailgun",
				`${this.#baseUrl}/v3/${encodeURIComponent(this.#domain)}/messages.mime`,
				{
					method: "POST",
					headers: {
						// HTTP Basic, the username is literally `api`.
						Authorization: `Basic ${Buffer.from(`api:${this.#apiKey}`).toString("base64")}`,
						Accept: "application/json",
					},
					body: form,
				},
			);
		} catch (err) {
			throw wrapFetchNetworkError("mailgun", err);
		}

		const raw = await res.text();
		if (!res.ok) {
			throw wrapMailgunError({
				status: res.status,
				message: raw,
				headers: Object.fromEntries(res.headers.entries()),
			});
		}
		// A 200 carries `{ id, message }`; anything unparseable is still a
		// success on the wire, so it is not turned into an error.
		try {
			const parsed: unknown = JSON.parse(raw);
			const id =
				typeof parsed === "object" && parsed !== null
					? Reflect.get(parsed, "id")
					: undefined;
			return {
				providerId:
					typeof id === "string" ? id.replace(/^<|>$/g, "") : undefined,
				envelope: composed.envelope,
			};
		} catch {
			return { envelope: composed.envelope };
		}
	}
}

/**
 * Map an upstream refusal onto the uniform `E_MAIL_PROVIDER_ERROR` every
 * transport raises, so retry and observability never branch on the provider.
 *
 * The shape is what the HTTP response gives: a status, the body as the
 * message, and the response headers — `Retry-After` among them, which the
 * backoff honours. A network failure never reaches here; `wrapFetchNetworkError`
 * carries the errno so the retry predicate can still see it.
 */
function wrapMailgunError(err: unknown): RoverError {
	if (err instanceof RoverError) return err;
	const anyErr = err as {
		status?: unknown;
		details?: string;
		message?: string;
		code?: string;
		headers?: Record<string, string | string[]>;
	};
	// Coerce a string-typed status into a number: the field is built here, but
	// a caller injecting a fake response may still hand one over as text.
	const statusNum = Number(anyErr.status);
	const status = Number.isFinite(statusNum) ? statusNum : 0;
	const providerMessage = redactSecrets(
		capMessage(anyErr.details ?? anyErr.message ?? "unknown"),
	);
	const ctx: Record<string, string> = {
		provider: "mailgun",
		upstreamStatus: String(status),
		providerMessage,
	};
	if (typeof anyErr.code === "string") {
		ctx.networkCode = anyErr.code;
	}
	// Retry-After may arrive either as a header (`retry-after`) or as a JSON
	// body field — pass both upstream so `computeBackoffMs` can honour it.
	const retryAfterHeader = anyErr.headers?.["retry-after"];
	if (retryAfterHeader) {
		ctx.retryAfter = Array.isArray(retryAfterHeader)
			? (retryAfterHeader[0] ?? "")
			: retryAfterHeader;
	}
	return new RoverError(
		"E_MAIL_PROVIDER_ERROR",
		`Mailgun returned ${status || "unknown"}`,
		{
			hint: "Inspect `context.upstreamStatus` (HTTP) or `context.networkCode` (ECONNRESET/etc.) to decide retry eligibility.",
			context: ctx,
		},
	);
}

registerTransport("mailgun", (config) => new MailgunTransport(config));
