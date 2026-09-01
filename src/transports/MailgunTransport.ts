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

		// CRLF stripping is applied at the wire boundary regardless of SDK
		// promises — defence-in-depth. Anti-pattern from spec Dev Notes:
		// "never skip CRLF sanitisation because the provider will handle it".
		const data: Record<string, unknown> = {
			from: stripCrlf(message.from),
			// Mailgun requires a `to`. A bcc-only message is valid (the validator
			// permits it), but an empty `to` makes create() 400 instead of
			// delivering to the bcc list. Fall back to the sender so the envelope is
			// accepted and the bcc recipients still receive it (audit 2026-06-13).
			to: (message.to.length > 0 ? message.to : [message.from]).map(stripCrlf),
			subject: stripCrlf(message.subject),
		};
		if (message.cc.length) data.cc = message.cc.map(stripCrlf);
		if (message.bcc.length) data.bcc = message.bcc.map(stripCrlf);
		if (message.text) data.text = message.text;
		if (message.html) data.html = message.html;
		if (message.replyTo) data["h:Reply-To"] = stripCrlf(message.replyTo);
		for (const [k, raw] of Object.entries(message.headers)) {
			const v = headerValue(raw);
			data[`h:${stripCrlf(k)}`] = Array.isArray(v)
				? v.map(stripCrlf).join(", ")
				: stripCrlf(v);
		}
		// Mailgun takes `multipart/form-data`; Node builds it, and `fetch` sets
		// the boundary. Scalars first, then one file part per attachment.
		const form = new FormData();
		for (const [key, value] of Object.entries(data)) {
			form.append(key, Array.isArray(value) ? value.join(", ") : String(value));
		}
		for (const att of attachmentsFor(message)) {
			const bytes = Buffer.from(att.content as Buffer | string);
			const blob = att.contentType
				? new Blob([bytes], { type: stripCrlf(att.contentType) })
				: new Blob([bytes]);
			form.append("attachment", blob, stripCrlf(att.filename));
		}

		let res: Response;
		try {
			res = await fetchWithTimeout(
				"Mailgun",
				`${this.#baseUrl}/v3/${encodeURIComponent(this.#domain)}/messages`,
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
			return typeof id === "string" ? { providerId: id } : undefined;
		} catch {
			return undefined;
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
