import formData from "form-data";
// mailgun.js is UMD-bundled; the class lives on `.default` under NodeNext.
import MailgunModule from "mailgun.js";
import {
	type MailMessage,
	type MailSendOutcome,
	type MailTransport,
	registerTransport,
} from "../Mail.js";
import { attachmentsFor, headerValue } from "../MessageBuilder.js";
import { RoverError } from "../RoverError.js";

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

/** Minimal mailgun.js client surface — matches the subset we need. */
interface MailgunClientLike {
	messages: {
		create(
			domain: string,
			data: Record<string, unknown>,
		): Promise<{ id?: string; message?: string; status?: number }>;
	};
}

export class MailgunTransport implements MailTransport {
	#client: MailgunClientLike;
	#domain: string;

	constructor(config: Record<string, unknown>) {
		const apiKey =
			typeof config.apiKey === "string" ? normalizeConfig(config.apiKey) : "";
		const domain =
			typeof config.domain === "string" ? normalizeConfig(config.domain) : "";
		if (!apiKey || !domain) {
			throw new RoverError(
				"MAIL_PROVIDER_CONFIG",
				"Mailgun transport requires apiKey and domain",
				{ hint: "Set { apiKey, domain } in your mail config." },
			);
		}
		this.#domain = domain;

		// Region: reject non-string when *defined* (wrong type signals a config
		// bug — defaulting to "us" under those conditions is a compliance risk).
		if (config.region !== undefined && typeof config.region !== "string") {
			throw new RoverError(
				"MAIL_PROVIDER_CONFIG",
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
				"MAIL_PROVIDER_CONFIG",
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

		// Dependency injection for tests: `_client` wins over real SDK. Guarded
		// against non-object and non-shape inputs so a typo'd config can't
		// silently bypass the real client.
		const injected = config._client;
		if (
			injected &&
			typeof injected === "object" &&
			"messages" in (injected as object) &&
			typeof (injected as MailgunClientLike).messages?.create === "function"
		) {
			this.#client = injected as MailgunClientLike;
		} else {
			// mailgun.js ships a UMD-style default export; the class constructor
			// lives on `.default` in the typings (`static get default`).
			const MailgunCtor = MailgunModule.default;
			const mailgun = new MailgunCtor(formData);
			this.#client = mailgun.client({ username: "api", key: apiKey, url });
		}
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
		if (attachmentsFor(message).length > 0) {
			data.attachment = attachmentsFor(message).map((att) => {
				const entry: { filename: string; data: Buffer; contentType?: string } =
					{
						filename: stripCrlf(att.filename),
						data: Buffer.from(att.content as Buffer | string),
					};
				if (att.contentType) {
					entry.contentType = stripCrlf(att.contentType);
				}
				return entry;
			});
		}

		try {
			const res = await this.#client.messages.create(this.#domain, data);
			if (res.id) return { providerId: res.id };
			return undefined;
		} catch (err) {
			throw wrapMailgunError(err);
		}
	}
}

/**
 * mailgun.js's own error shape is `{ status, details | message, ... }`.
 * Map it to our uniform `MAIL_PROVIDER_ERROR` so retry + observability
 * consumers don't need to branch on provider.
 *
 * Bare `Error` (no `status`) — typical for network/ECONNRESET failures from
 * mailgun.js — surface the original errno (`code`) in context so the retry
 * predicate can still classify it as transient.
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
	// Coerce string-typed status ("401") into number — mailgun.js is
	// inconsistent across versions.
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
		"MAIL_PROVIDER_ERROR",
		`Mailgun returned ${status || "unknown"}`,
		{
			hint: "Inspect `context.upstreamStatus` (HTTP) or `context.networkCode` (ECONNRESET/etc.) to decide retry eligibility.",
			context: ctx,
		},
	);
}

registerTransport("mailgun", (config) => new MailgunTransport(config));
