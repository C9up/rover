import { RoverError } from "../RoverError.js";
import sgMail, {
	type MailDataRequired,
	type MailService,
} from "@sendgrid/mail";
import {
	type MailMessage,
	type MailSendOutcome,
	type MailTransport,
	registerTransport,
} from "../Mail.js";

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

/**
 * Minimal slice of the SendGrid client we depend on. A per-transport client
 * instance is created in the constructor so concurrent transports with
 * different API keys cannot race each other — the original module-level
 * `sgMail.setApiKey()` would have been a multi-tenant foot-gun.
 */
interface SendGridClientLike {
	setApiKey(apiKey: string): void;
	send(
		data: MailDataRequired,
	): Promise<
		[
			{ statusCode: number; headers: Record<string, string | string[]> },
			unknown,
		]
	>;
}

export class SendGridTransport implements MailTransport {
	#client: SendGridClientLike;

	constructor(config: Record<string, unknown>) {
		const apiKey =
			typeof config.apiKey === "string" ? normalizeConfig(config.apiKey) : "";
		if (!apiKey) {
			throw new RoverError(
				"MAIL_PROVIDER_CONFIG",
				"SendGrid transport requires apiKey",
				{ hint: "Set { apiKey } in your mail config." },
			);
		}

		// Dependency injection for tests — stronger guard than the old version
		// (require both `send` AND `setApiKey` to pass through).
		const injected = config._client;
		if (
			injected &&
			typeof injected === "object" &&
			typeof (injected as SendGridClientLike).send === "function" &&
			typeof (injected as SendGridClientLike).setApiKey === "function"
		) {
			this.#client = injected as SendGridClientLike;
		} else {
			// Per-instance MailService (not the shared `sgMail` singleton) so
			// `setApiKey` can't race across multiple transports.
			this.#client = new (resolveMailServiceCtor(sgMail))();
		}
		this.#client.setApiKey(apiKey);
	}

	async send(message: MailMessage): Promise<MailSendOutcome> {
		assertHasRecipients(message);
		const content = buildSendGridContent(message);

		// CRLF stripping at the wire boundary (defence-in-depth, matches the
		// Dev Notes anti-pattern: never trust the SDK to handle it).
		const data: MailDataRequired = {
			from: stripCrlf(message.from),
			to: message.to.map(stripCrlf),
			subject: stripCrlf(message.subject),
			content,
			...(message.cc.length ? { cc: message.cc.map(stripCrlf) } : {}),
			...(message.bcc.length ? { bcc: message.bcc.map(stripCrlf) } : {}),
			...(message.replyTo ? { replyTo: stripCrlf(message.replyTo) } : {}),
			...(Object.keys(message.headers).length
				? {
						headers: Object.fromEntries(
							Object.entries(message.headers).map(([k, v]) => [
								stripCrlf(k),
								stripCrlf(v),
							]),
						),
					}
				: {}),
			...(message.attachments.length
				? {
						attachments: message.attachments.map((att) => {
							const entry: {
								filename: string;
								content: string;
								type?: string;
								disposition: "attachment";
							} = {
								filename: stripCrlf(att.filename),
								content: Buffer.from(att.content as Buffer | string).toString(
									"base64",
								),
								disposition: "attachment" as const,
							};
							if (att.contentType) entry.type = stripCrlf(att.contentType);
							return entry;
						}),
					}
				: {}),
		};

		try {
			const result = await this.#client.send(data);
			// Guard against non-standard SDK responses: `[]`, `[undefined]`, etc.
			const response = Array.isArray(result) ? result[0] : undefined;
			const msgId = response?.headers?.["x-message-id"];
			const idStr = Array.isArray(msgId) ? msgId[0] : msgId;
			if (idStr && typeof idStr === "string" && idStr.length > 0) {
				return { providerId: idStr };
			}
			return undefined;
		} catch (err) {
			throw wrapSendGridError(err);
		}
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
			"MAIL_PROVIDER_CONFIG",
			"Mail message has no recipients",
			{ hint: "Set at least one `to`, `cc`, or `bcc` before sending." },
		);
	}
}

/**
 * Build the SendGrid v3 `content[]`: text/plain when text is set, text/html when
 * html is set, always at least one entry (SendGrid rejects empty content). The
 * non-empty tuple type lets the SDK's MailDataRequired see `content[0]` exists.
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
	// @sendgrid/mail throws `{ code, message, response: { body, headers, statusCode } }`
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
		"MAIL_PROVIDER_ERROR",
		`SendGrid returned ${status || "unknown"}`,
		{
			hint: "Inspect `context.upstreamStatus` (HTTP) or `context.networkCode` (ECONNRESET/etc.) to decide retry eligibility. `context.retryAfter` (when set) carries the provider's backoff hint in seconds.",
			context: ctx,
		},
	);
}

/**
 * Type-guard resolver for the `MailService` constructor attached to the
 * module's default export at runtime. The cerebrum forbids `as unknown as T`;
 * here we receive `sgMail` through a parameter typed `unknown`, narrow with
 * runtime `typeof` checks, and return a single cast to a precise callable
 * type. No double-cast chain, no `as unknown` anchor.
 */
function resolveMailServiceCtor(mod: unknown): new () => MailService {
	if (mod && typeof mod === "object" && "MailService" in mod) {
		const candidate = (mod as { MailService: unknown }).MailService;
		if (typeof candidate === "function") {
			return candidate as new () => MailService;
		}
	}
	throw new RoverError(
		"MAIL_PROVIDER_CONFIG",
		"@sendgrid/mail runtime does not expose `.MailService` — upgrade to v8+",
		{
			hint: "Expected `module.exports.MailService` to be the MailService class (index.js attaches it).",
		},
	);
}

registerTransport("sendgrid", (config) => new SendGridTransport(config));
