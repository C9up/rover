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

export class SendGridTransport implements MailTransport {
	#apiKey: string;
	#baseUrl: string;

	constructor(config: Record<string, unknown>) {
		const apiKey =
			typeof config.apiKey === "string" ? normalizeConfig(config.apiKey) : "";
		if (!apiKey) {
			throw new RoverError(
				"E_MAIL_PROVIDER_CONFIG",
				"SendGrid transport requires apiKey",
				{ hint: "Set { apiKey } in your mail config." },
			);
		}

		this.#apiKey = apiKey;
		this.#baseUrl =
			typeof config.baseUrl === "string" && config.baseUrl.length > 0
				? normalizeConfig(config.baseUrl).replace(/\/+$/, "")
				: "https://api.sendgrid.com";
	}

	async send(message: MailMessage): Promise<MailSendOutcome> {
		assertHasRecipients(message);

		// CRLF is stripped at the wire boundary regardless of what the provider
		// promises — a header injected through a recipient or a subject is the
		// one thing a transport must never pass on.
		const address = (value: string): { email: string } => ({
			email: stripCrlf(value),
		});
		const personalization: Record<string, unknown> = {
			// `to` may be empty when a message is bcc-only, which SendGrid allows.
			to: message.to.map(address),
		};
		if (message.cc.length) personalization.cc = message.cc.map(address);
		if (message.bcc.length) personalization.bcc = message.bcc.map(address);

		const body: Record<string, unknown> = {
			// The v3 API groups recipients under `personalizations`; the SDK's
			// flat shape was its own, and this is what actually goes on the wire.
			personalizations: [personalization],
			from: address(message.from),
			subject: stripCrlf(message.subject),
			content: buildSendGridContent(message),
		};
		if (message.replyTo) body.reply_to = address(message.replyTo);
		if (Object.keys(message.headers).length) {
			body.headers = Object.fromEntries(
				Object.entries(message.headers).map(([k, raw]) => {
					const v = headerValue(raw);
					return [
						stripCrlf(k),
						Array.isArray(v) ? v.map(stripCrlf).join(", ") : stripCrlf(v),
					];
				}),
			);
		}
		const attachments = attachmentsFor(message);
		if (attachments.length > 0) {
			body.attachments = attachments.map((att) => {
				const entry: Record<string, string> = {
					filename: stripCrlf(att.filename),
					content: Buffer.from(att.content as Buffer | string).toString(
						"base64",
					),
					disposition: "attachment",
				};
				if (att.contentType) entry.type = stripCrlf(att.contentType);
				return entry;
			});
		}

		let res: Response;
		try {
			res = await fetchWithTimeout(
				"SendGrid",
				`${this.#baseUrl}/v3/mail/send`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${this.#apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
				},
			);
		} catch (err) {
			throw wrapFetchNetworkError("sendgrid", err);
		}

		if (!res.ok) {
			// Shaped as the mapper already reads it, so the mapping stays one
			// piece of logic rather than two that can drift.
			throw wrapSendGridError({
				response: {
					statusCode: res.status,
					body: await res.text(),
					headers: Object.fromEntries(res.headers.entries()),
				},
			});
		}
		// A 202 carries no body; the id is in the header.
		const id = res.headers.get("x-message-id");
		return id !== null && id.length > 0 ? { providerId: id } : undefined;
	}
}

type SendGridContent = { type: string; value: string };

function assertHasRecipients(message: MailMessage): void {
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
}

/**
 * Build the SendGrid v3 `content[]`: text/plain when text is set, text/html when
 * html is set, always at least one entry (SendGrid rejects empty content). The
 * At least one entry always: SendGrid refuses a message with empty content.
 */
function buildSendGridContent(
	message: MailMessage,
): [SendGridContent, ...SendGridContent[]] {
	const first: SendGridContent = message.text
		? { type: "text/plain", value: message.text }
		: message.html
			? { type: "text/html", value: message.html }
			: { type: "text/plain", value: "" };
	const rest: SendGridContent[] = [];
	if (message.text && message.html) {
		rest.push({ type: "text/html", value: message.html });
	}
	return [first, ...rest];
}

function wrapSendGridError(err: unknown): RoverError {
	if (err instanceof RoverError) return err;
	// Built from the HTTP response here, but the older SDK shape
	// (`{ code, message, response: { body, headers, statusCode } }`) is still
	// accepted so an injected fake or a wrapped error maps the same way.
	const anyErr = err as {
		code?: number | string;
		message?: string;
		response?: {
			statusCode?: number;
			body?: unknown;
			headers?: Record<string, string>;
		};
	};
	const statusFromResponse = anyErr.response?.statusCode;
	const statusFromCode = Number(anyErr.code);
	const status = Number.isFinite(statusFromResponse as number)
		? (statusFromResponse as number)
		: Number.isFinite(statusFromCode)
			? statusFromCode
			: 0;
	const body = anyErr.response?.body;
	const providerMessage = redactSecrets(
		capMessage(
			typeof body === "string"
				? body
				: body !== undefined
					? JSON.stringify(body)
					: (anyErr.message ?? "unknown"),
		),
	);
	const ctx: Record<string, string> = {
		provider: "sendgrid",
		upstreamStatus: String(status),
		providerMessage,
	};
	if (typeof anyErr.code === "string") {
		ctx.networkCode = anyErr.code;
	}
	const retryAfter = anyErr.response?.headers?.["retry-after"];
	if (retryAfter) ctx.retryAfter = retryAfter;
	return new RoverError(
		"E_MAIL_PROVIDER_ERROR",
		`SendGrid returned ${status || "unknown"}`,
		{
			hint: "Inspect `context.upstreamStatus` (HTTP) or `context.networkCode` (ECONNRESET/etc.) to decide retry eligibility. `context.retryAfter` (when set) carries the provider's backoff hint in seconds.",
			context: ctx,
		},
	);
}

registerTransport("sendgrid", (config) => new SendGridTransport(config));
