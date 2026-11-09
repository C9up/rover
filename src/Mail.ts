import { randomBytes } from "node:crypto";
import nodemailer, { type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import { BaseMail, type MailAddress } from "./BaseMail.js";
import {
	assertRecipient,
	formatRecipient,
	type Recipient,
	recipientAddress,
	toNodemailerAddress,
	toRecipient,
} from "./format.js";
import {
	assertEnvelope,
	assertHeaders,
	type MailAttachment,
	type MailMessage,
	type MessageBodyTemplates,
	MessageBuilder,
} from "./MessageBuilder.js";
import {
	type BayQueueLike,
	MAIL_JOB_NAME,
	MailJobHandler,
} from "./queue/MailJob.js";
import { MemoryMailMessenger } from "./queue/MemoryMailMessenger.js";
import { RoverError } from "./RoverError.js";
import {
	computeBackoffMs,
	isRetryableError,
	type RetryConfig,
	resolveRetryConfig,
} from "./retry.js";
import { setViewsRoot } from "./templating/SimpleTemplate.js";
import { FakeMail } from "./testing/FakeMail.js";

// `MailMessage` / `MailAttachment` / `MessageBuilder` live in MessageBuilder.ts
// so `BaseMail` can import the builder without importing this module — breaking
// the BaseMail ↔ Mail value cycle. Re-exported here to keep the public surface
// (`@c9up/rover` → these symbols come from `./Mail.js`) unchanged.
export type { MailAttachment, MailMessage };
export { MessageBuilder };

/**
 * Mail — send emails via pluggable transports.
 *
 * Like AdonisJS Mail:
 *   await mail.send((message) => {
 *     message.to('user@example.com')
 *     message.subject('Welcome')
 *     message.html('<h1>Hello</h1>')
 *   })
 *
 * Transports: SMTP, log (dev), custom.
 * Configured via config/mail.ts.
 */

export interface MailSendResult {
	/** Provider-returned message id (Mailgun `mg-abc`, SendGrid `X-Message-Id`, etc.). */
	providerId?: string;
	/** The envelope actually used, when the transport knows it (SMTP). */
	envelope?: MailResponseEnvelope;
	/** The transport's raw result, surfaced as `MailResponse.original`. */
	original?: unknown;
}

/** Who the servers were told the message is from and to (MAIL FROM / RCPT TO). */
export interface MailResponseEnvelope {
	from: string | false;
	to: string[];
}

/**
 * What `send()` / `sendCompiled()` resolve to (AdonisJS `MailResponse`): the
 * message id to correlate with provider webhooks, the envelope, and the
 * transport's raw result.
 */
export class MailResponse<T = unknown> {
	messageId: string;
	envelope: MailResponseEnvelope;
	original: T;

	constructor(messageId: string, envelope: MailResponseEnvelope, original: T) {
		this.messageId = messageId;
		this.envelope = envelope;
		this.original = original;
	}
}

/**
 * Return shape of `MailTransport.send`. Transports that don't surface a
 * provider id may `return` nothing (implicit `undefined`); transports that
 * do return `{ providerId }`. `undefined` rather than `void` in the union
 * keeps the linter happy (`noConfusingVoidType`) while preserving the
 * "no result" semantics.
 */
export type MailSendOutcome = MailSendResult | undefined;

export interface MailTransport {
	send(message: MailMessage): Promise<MailSendOutcome>;
	/**
	 * Release what this transport holds open — an SMTP connection pool, mostly.
	 * Optional: an HTTP-API transport has nothing to close.
	 */
	close?(): Promise<void>;
}

/**
 * Structural interface for the event bus `Emitter` — peer-dep friendly.
 * Rover never hard-imports the event bus.
 */
export interface EmitterLike {
	/**
	 * `unknown`, not `void`: a `void` return ACCEPTS a promise-returning
	 * function, which is how an Adonis emitter's rejection went unnoticed.
	 */
	emit(event: string, data: unknown): unknown;
}

/**
 * What every mail lifecycle event carries, matching `@adonisjs/mail`:
 * the mailer that handled it, the message itself, and the templates it was
 * rendered from. A listener migrating over reads `message.to` / `views.html`.
 *
 * `transportName` and the flattened recipient lists are rover's own and stay:
 * the transport name is the same string as `mailerName` under the name rover
 * used first, and a listener that only wants the addresses should not have to
 * reach into the message for them.
 */
export type { MessageBodyTemplates };

export interface MailEventBase {
	/** AdonisJS name for the mailer that handled the message. */
	mailerName: string;
	/** The built message. */
	message: MailMessage;
	/** Templates the message was rendered from, empty when it carried none. */
	views: MessageBodyTemplates;
	to: string[];
	cc: string[];
	bcc: string[];
	/** rover's original name for {@link MailEventBase.mailerName}. */
	transportName: string;
	timestamp: number;
}

/**
 * Emitted (`mail:sending`) right before the transport `send` runs — no
 * `messageId` yet, since the provider hasn't accepted the message.
 */
export interface MailSendingEvent extends MailEventBase {}

export interface MailSentEvent extends MailEventBase {
	messageId: string;
	/** What `send()` resolved to (AdonisJS `response`). */
	response: MailResponse;
}

/**
 * Emitted for the queue lifecycle (`mail:queueing` / `mail:queued`). `jobId` is
 * only present on `mail:queued` (once the job has been accepted by the queue /
 * in-memory messenger).
 */
export interface MailQueueEvent extends MailEventBase {
	queue: string;
	jobId?: string;
}

export interface MailFailedEvent extends MailEventBase {
	messageId: string;
	error: {
		code: string;
		message: string;
		upstreamStatus?: number;
		upstreamStatusRaw?: string;
		attempts: number;
	};
}

export interface MailConfig {
	/**
	 * Mailer used when `send()` is called without naming one. It has to be a
	 * key of {@link MailConfig.mailers}, or the constructor throws.
	 */
	default: string;
	/** Default sender: an address, or `{ address, name }`. */
	from: MailAddress;
	/**
	 * The declared mailers, name → the transport it sends through plus that
	 * transport's own settings. Build the entries with the `transports.*`
	 * helpers.
	 */
	mailers?: Record<
		string,
		{ transport: string; retry?: Partial<RetryConfig>; [key: string]: unknown }
	>;
	/**
	 * Rover's older spelling of `mailers`. Still accepted and identical in
	 * effect; new configs declare `mailers`.
	 */
	transports?: Record<
		string,
		{ transport: string; retry?: Partial<RetryConfig>; [key: string]: unknown }
	>;
	/** Root directory for `htmlView(path, data)` template lookups. Default: `"resources/views/emails"`. */
	viewsRoot?: string;
	/** Optional Bay queue tuning for `sendLater()`. */
	queue?: { name?: string; maxAttempts?: number };
	/** Process-wide retry defaults. Overridden per-mailer via `mailers[name].retry`. */
	retry?: Partial<RetryConfig>;
}

/**
 * Event hooks invoked by the internal dispatch loop. Default implementations
 * are no-ops; when an event-bus `EmitterLike` is wired, the hooks emit the
 * `mail:*` events (colon-namespaced, `@adonisjs/mail` parity). Tests inject
 * spies.
 */
export interface MailHooks {
	onSending?(event: MailSendingEvent): void;
	onSent?(event: MailSentEvent): void;
	onFailed?(event: MailFailedEvent): void;
	onQueueing?(event: MailQueueEvent): void;
	onQueued?(event: MailQueueEvent): void;
}

/**
 * Message builder — fluent API for composing an email.
 */
/**
 * SMTP transport — thin wrapper around `nodemailer`. Nodemailer handles
 * the SMTP state machine, TLS / STARTTLS negotiation, AUTH LOGIN /
 * PLAIN / XOAUTH2, dot-stuffing, MIME assembly, attachments, and address
 * encoding for 10+ years. We forward the `MailMessage` shape and surface
 * the `messageId` returned by the server.
 */
export class SmtpTransport implements MailTransport {
	#transporter: Transporter;

	constructor(config: Record<string, unknown>) {
		// Host is required — defaulting to "localhost" silently hid env-var
		// misconfigurations (SMTP_HOST unset) until the SMTP connection
		// timed out against a nonexistent local server. Fail at
		// construction with an actionable message instead.
		if (config.host !== undefined && typeof config.host !== "string") {
			throw new RoverError(
				"E_MAIL_PROVIDER_CONFIG",
				`SMTP host must be a string, got ${typeof config.host}`,
				{ hint: "Set config.host to your SMTP server hostname." },
			);
		}
		if (typeof config.host !== "string" || config.host.length === 0) {
			throw new RoverError("E_MAIL_PROVIDER_CONFIG", "SMTP host is required", {
				hint: "Set config.host (e.g. process.env.SMTP_HOST). Use the fake / log transports for local development.",
			});
		}
		const user = typeof config.user === "string" ? config.user : undefined;
		const pass = typeof config.pass === "string" ? config.pass : undefined;
		// Partial auth config (only user OR only pass) is almost always a typo —
		// fail fast rather than connect anonymously and let the server reject.
		if ((user && !pass) || (!user && pass)) {
			throw new RoverError(
				"E_MAIL_PROVIDER_CONFIG",
				"SMTP auth requires both `user` and `pass` or neither",
				{
					hint: "Check your env vars — one half of the credential pair is missing.",
				},
			);
		}
		if (user && config.auth !== undefined) {
			throw new RoverError(
				"E_MAIL_PROVIDER_CONFIG",
				"SMTP config sets both `user`/`pass` and `auth`",
				{ hint: "Keep one: the `user`/`pass` shorthand or the `auth` object." },
			);
		}

		// Everything else is nodemailer's own SMTP options, forwarded whole as
		// the upstream SMTP transport does: tls, pool, timeouts, dkim, OAuth2
		// `auth`, `service`, `name`, `proxy`, logger.
		const options: SMTPTransport.Options = {};
		const forwarded: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(config)) {
			if (!ROVER_SMTP_KEYS.has(key)) forwarded[key] = value;
		}
		Object.assign(options, forwarded);
		options.port = smtpPort(config.port);
		if (user && pass) options.auth = { user, pass };

		// Credentials must never cross the wire before TLS is up. nodemailer's
		// default is opportunistic STARTTLS: when the EHLO reply does not list
		// STARTTLS, which is all a man in the middle has to strip, it carries on
		// in plaintext and sends AUTH. requireTLS makes it abort instead.
		// Stricter than the upstream default, deliberately (RFC 8314 §3.1).
		if (options.auth !== undefined && config.allowInsecureAuth !== true) {
			if (
				config.requireTLS === false ||
				config.ignoreTLS === true ||
				config.opportunisticTLS === true
			) {
				throw new RoverError(
					"E_MAIL_PROVIDER_CONFIG",
					"SMTP credentials are configured with TLS turned off (requireTLS: false, ignoreTLS or opportunisticTLS)",
					{
						hint: "Use secure: true (port 465) or STARTTLS on 587. For a local development server without TLS, set allowInsecureAuth: true.",
					},
				);
			}
			options.requireTLS = true;
		}

		// Allow DI for tests: if the config carries a pre-built transporter,
		// use it instead of nodemailer.createTransport.
		const injected = config._transporter;
		if (injected && typeof injected === "object" && "sendMail" in injected) {
			this.#transporter = injected as Transporter;
		} else {
			this.#transporter = nodemailer.createTransport(options);
		}
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
		try {
			const info = await this.#transporter.sendMail({
				// Address objects, which nodemailer never re-splits: a string would
				// be parsed as an address list.
				from: toNodemailerAddress(message.from),
				to: message.to.map(toNodemailerAddress),
				cc: message.cc.length ? message.cc.map(toNodemailerAddress) : undefined,
				bcc: message.bcc.length
					? message.bcc.map(toNodemailerAddress)
					: undefined,
				replyTo: message.replyTo?.length
					? message.replyTo.map(toNodemailerAddress)
					: undefined,
				subject: message.subject,
				html: message.html,
				text: message.text,
				// nodemailer reads `watchHtml`; there is no bare `watch` field in
				// its mail composer, so writing one — as AdonisJS does — never
				// reaches the wire.
				watchHtml: message.watchHtml,
				// MAIL FROM / RCPT TO, when they differ from the headers.
				envelope: message.envelope ? { ...message.envelope } : undefined,
				priority: message.priority,
				messageId: message.messageId,
				inReplyTo: message.inReplyTo,
				references: message.references,
				headers: Object.keys(message.headers).length
					? message.headers
					: undefined,
				encoding: message.encoding,
				// `list` is NOT passed: `build()` already rendered the `List-*`
				// headers into `headers`, so handing nodemailer the structured form
				// too would emit each of them twice.
				icalEvent: message.icalEvent,
				attachments: message.attachments.length
					? message.attachments.map((att) => ({
							filename: att.filename,
							content: att.content,
							contentType: att.contentType,
							cid: att.cid,
							contentDisposition: att.contentDisposition,
							encoding: att.encoding,
							headers: att.headers,
						}))
					: undefined,
			});
			return {
				providerId: info.messageId || undefined,
				envelope: isEnvelope(info.envelope) ? info.envelope : undefined,
				original: info,
			};
		} catch (err) {
			throw wrapSmtpError(err);
		}
	}

	/**
	 * Drain nodemailer's connection pool. Idempotent — nodemailer tolerates a
	 * second close, and a shutdown path may run twice.
	 */
	async close(): Promise<void> {
		this.#transporter.close();
	}
}

/** Config keys rover reads itself; every other key is a nodemailer option. */
const ROVER_SMTP_KEYS = new Set([
	"transport",
	"retry",
	"user",
	"pass",
	"port",
	"allowInsecureAuth",
	"_transporter",
]);

/**
 * The port as nodemailer wants it. An env value is a string, so `"2525"` is
 * accepted; left out, nodemailer picks 587, or 465 when `secure` is set.
 */
function smtpPort(port: unknown): number | undefined {
	if (port === undefined || port === "") return undefined;
	if (typeof port === "number" && Number.isInteger(port)) return port;
	if (typeof port === "string" && /^\d+$/.test(port)) return Number(port);
	throw new RoverError(
		"E_MAIL_PROVIDER_CONFIG",
		`SMTP port must be an integer, got ${JSON.stringify(port)}`,
		{ hint: "Set config.port to a number such as 587 or 465." },
	);
}

/**
 * Normalise nodemailer / socket errors into the uniform `E_MAIL_PROVIDER_ERROR`
 * shape used by the rest of the library. Preserves the `code` field (errno)
 * in `context.networkCode` so `isRetryableError` can classify transient
 * network failures without losing the root cause.
 */
function wrapSmtpError(err: unknown): RoverError {
	if (err instanceof RoverError) return err;
	const anyErr = err as {
		code?: string | number;
		responseCode?: number;
		message?: string;
	};
	const status =
		typeof anyErr.responseCode === "number" ? anyErr.responseCode : 0;
	const ctx: Record<string, string> = {
		provider: "smtp",
		upstreamStatus: String(status),
		providerMessage: anyErr.message ?? "unknown",
	};
	if (typeof anyErr.code === "string") {
		ctx.networkCode = anyErr.code;
	}
	return new RoverError(
		"E_MAIL_PROVIDER_ERROR",
		`SMTP failed: ${anyErr.message ?? "unknown"}`,
		{
			hint: "Inspect `context.networkCode` (ECONNRESET/ETIMEDOUT/...) or `context.upstreamStatus` (SMTP response code) to decide retry eligibility.",
			context: ctx,
		},
	);
}

/**
 * Log transport — logs emails to console (development).
 *
 * The body stays out of the log unless `logBody: true` is set: a mailer left on
 * `log` by mistake would otherwise copy reset links and one-time codes into
 * the log pipeline. Every field is JSON-encoded, so a CR/LF in a subject
 * cannot forge a second log line.
 */
export class LogTransport implements MailTransport {
	readonly #logBody: boolean;

	constructor(config: Record<string, unknown> = {}) {
		this.#logBody = config.logBody === true;
	}

	async send(message: MailMessage): Promise<MailSendOutcome> {
		console.log(
			`[MAIL] To: ${JSON.stringify(message.to.map(formatRecipient))} | Subject: ${JSON.stringify(message.subject)}`,
		);
		if (this.#logBody && message.text) {
			console.log(`  Body: ${JSON.stringify(message.text.slice(0, 200))}`);
		}
		return undefined;
	}
}

export type MailTransportFactory = (
	config: Record<string, unknown>,
) => MailTransport;

const transportFactories: Record<string, MailTransportFactory> = {
	smtp: (config) => new SmtpTransport(config),
	log: (config) => new LogTransport(config),
};

/**
 * Register a custom transport factory globally.
 *
 * @example
 *   registerTransport('mailgun', (config) => new MailgunTransport(config))
 *   // Now config/mail.ts can reference `transport: 'mailgun'`
 */
export function registerTransport(
	name: string,
	factory: MailTransportFactory,
): void {
	transportFactories[name] = factory;
}

/**
 * Mail manager — send emails via configured transport.
 */
export class Mail {
	#transports: Map<string, MailTransport> = new Map();
	#mailers: Map<string, Mailer> = new Map();
	#defaultTransport: string;
	#defaultFrom: MailAddress;
	/** Active `FakeMail`, when `fake()` mode is on. Manager-level (captures both `send` and `sendLater`), not a transport swap. */
	#fake: FakeMail | null = null;
	#queue: BayQueueLike | null = null;
	/** Default in-memory messenger for `sendLater()` when no Bay queue is wired (Adonis MemoryQueueMessenger parity). */
	#memoryMessenger: MemoryMailMessenger;
	#queueName: string;
	#queueMaxAttempts: number;
	#globalRetry: Partial<RetryConfig> | undefined;
	#transportRetry: Map<string, Partial<RetryConfig>> = new Map();
	#hooks: MailHooks;
	#emitter: EmitterLike | null;
	/** Per-instance template root, threaded into each render so concurrent Mails with different roots don't clobber the shared global. */
	#viewsRoot: string | undefined;

	constructor(
		config: MailConfig,
		options?: {
			queue?: BayQueueLike;
			hooks?: MailHooks;
			emitter?: EmitterLike;
		},
	) {
		this.#defaultTransport = config.default;
		this.#defaultFrom = config.from;
		// Bay uses a single `name` for both `register(name, handler)` and
		// `dispatch(name, payload)`. Default to the canonical mail job name.
		this.#queueName = config.queue?.name ?? MAIL_JOB_NAME;
		this.#queueMaxAttempts = config.queue?.maxAttempts ?? 3;
		this.#globalRetry = config.retry;
		this.#hooks = options?.hooks ?? {};
		this.#emitter = options?.emitter ?? null;
		this.#memoryMessenger = new MemoryMailMessenger(this, this.#emitter);
		this.#viewsRoot = config.viewsRoot;
		// Keep mutating the process-wide global too: standalone MessageBuilder
		// usage (not routed through this Mail) still reads it. The per-instance
		// #viewsRoot threaded into #buildMessage is what isolates Mail.send().
		if (config.viewsRoot !== undefined) {
			setViewsRoot(config.viewsRoot);
		}

		// `mailers` and `transports` name the same map; a config that sets both
		// gets both, and `mailers` wins on a key the two share.
		const declared = { ...config.transports, ...config.mailers };
		for (const [name, transportConfig] of Object.entries(declared)) {
			const factory = transportFactories[transportConfig.transport];
			if (!factory) {
				throw new RoverError(
					"E_MAIL_UNKNOWN_TRANSPORT",
					`Unknown mail transport type '${transportConfig.transport}' (configured under name '${name}')`,
					{
						hint: "Register the transport with registerTransport() before constructing Mail, or fix the typo in config.mail.transports[*].transport.",
					},
				);
			}
			this.#transports.set(name, factory(transportConfig));
			if (transportConfig.retry) {
				this.#transportRetry.set(name, transportConfig.retry);
			}
		}

		// A `default` naming nothing is a configuration typo, and the cost of
		// letting it through is that the app boots, looks healthy, and throws on
		// the first email it tries to send — often a password reset, in
		// production. Refuse at construction and name what was declared.
		if (!this.#transports.has(this.#defaultTransport)) {
			throw new RoverError(
				"E_MAIL_UNKNOWN_MAILER",
				`Mail default mailer '${this.#defaultTransport}' is not declared in config.mailers`,
				{
					hint: `${knownMailers(this.#transports)} Add it, or point \`default\` at one of them.`,
				},
			);
		}

		if (options?.queue) {
			this.setMessenger(options.queue);
		}
	}

	/**
	 * Send a message that is already built (AdonisJS `sendCompiled`).
	 *
	 * What a queue worker calls: the message was composed and serialised
	 * elsewhere, so there is nothing left to render. An alias of
	 * {@link dispatchMessage}, which is the name ream used first.
	 */
	async sendCompiled(
		message: MailMessage,
		transport?: string,
	): Promise<MailResponse> {
		return this.dispatchMessage(message, transport);
	}

	/**
	 * Queue a message that is already built (AdonisJS `sendLaterCompiled`).
	 *
	 * Returns the job id, like {@link sendLater}.
	 */
	async sendLaterCompiled(
		message: MailMessage,
		options?: { transport?: string; queue?: string },
	): Promise<string> {
		// No views: a compiled message was rendered elsewhere, and the templates
		// that produced it did not travel with it.
		return this.#enqueue({ message, views: {} }, options);
	}

	/**
	 * Hand `sendLater()` a queue after construction (AdonisJS `setMessenger`).
	 *
	 * The constructor takes one too, but a queue is often resolved later than
	 * the mailer — a provider that boots after this one, a test that swaps it.
	 * Without this the only way in was the constructor, so an app migrating
	 * from `mail.setMessenger(queue)` stopped at a TypeError.
	 *
	 * "Messenger" is upstream's word for what rover's config calls `queue`;
	 * they are the same thing, and the method keeps the upstream name so a
	 * migrated call site resolves.
	 */
	setMessenger(messenger: BayQueueLike): this {
		this.#queue = messenger;
		this.#queue.register(this.#queueName, new MailJobHandler(this));
		return this;
	}

	/** Send an email using the fluent message builder. */
	async send(
		callback: (message: MessageBuilder) => void,
		transport?: string,
	): Promise<MailResponse>;
	/** Send an email using a class-based `BaseMail` instance. */
	async send(instance: BaseMail, transport?: string): Promise<MailResponse>;
	async send(
		arg: ((message: MessageBuilder) => void) | BaseMail,
		transport?: string,
	): Promise<MailResponse> {
		const transportName = transport ?? this.#defaultTransport;
		// Fake mode is manager-level: capture the built message (and the source
		// BaseMail, for constructor-based assertions) instead of touching a
		// transport. Still fire the send lifecycle so event wiring stays testable.
		if (this.#fake !== null) {
			const { message, views } = await this.#buildMessageWithViews(arg);
			this.#fake.trackSent(message, arg instanceof BaseMail ? arg : undefined);
			const base = this.#eventBase(message, views, transportName);
			const response = new MailResponse(
				randomBytes(16).toString("hex"),
				envelopeOf(message),
				undefined,
			);
			this.#fireSending(base);
			this.#fireSent({ ...base, messageId: response.messageId, response });
			return response;
		}
		// Validate the mailer up-front, before running any callback / prepare()
		// side effects.
		this.#requireTransport(transportName);

		const { message, views } = await this.#buildMessageWithViews(arg);
		return this.dispatchMessage(message, transportName, undefined, views);
	}

	/**
	 * Enqueue a send. Returns the job id. When a `@c9up/bay` `QueueManager` was
	 * wired it enqueues there; otherwise it falls back to the default in-memory
	 * messenger (immediate microtask dispatch), matching `@adonisjs/mail`'s
	 * `MemoryQueueMessenger` — `sendLater()` never throws for a missing queue.
	 */
	async sendLater(
		arg: ((message: MessageBuilder) => void) | BaseMail,
		options?: { transport?: string; queue?: string },
	): Promise<string> {
		const built = await this.#buildMessageWithViews(arg);
		return this.#enqueue(
			{ ...built, source: arg instanceof BaseMail ? arg : undefined },
			options,
		);
	}

	/** The queueing half, shared with {@link sendLaterCompiled}. */
	async #enqueue(
		built: {
			message: MailMessage;
			views: MessageBodyTemplates;
			/** The BaseMail it came from, for `assertQueued(WelcomeMail)`. */
			source?: BaseMail;
		},
		options?: { transport?: string; queue?: string },
	): Promise<string> {
		const { message, views } = built;
		const queueName = options?.queue ?? this.#queueName;
		const transportName = options?.transport ?? this.#defaultTransport;
		const base: MailQueueEvent = {
			...this.#eventBase(message, views, transportName),
			queue: queueName,
		};

		// Fake mode: capture into the queued bucket, don't dispatch.
		if (this.#fake !== null) {
			this.#fake.trackQueued(message, built.source);
			const jobId = `fake_${randomBytes(12).toString("hex")}`;
			this.#fireQueueing(base);
			this.#fireQueued({ ...base, jobId });
			return jobId;
		}

		this.#fireQueueing(base);
		const jobId =
			this.#queue !== null
				? await this.#queue.dispatch(
						queueName,
						{ message, transport: options?.transport },
						{ maxAttempts: this.#queueMaxAttempts },
					)
				: this.#memoryMessenger.queue(message, options?.transport);
		this.#fireQueued({ ...base, jobId });
		return jobId;
	}

	/**
	 * Shared transport-resolve-then-send helper used by `send()` and `MailJobHandler`.
	 * Applies in-process retry with exponential backoff per `RetryConfig` resolution
	 * (per-transport > global > library default). Fires `onSent` / `onFailed` hooks.
	 *
	 * `overrideRetry` (optional) wins over config-level retry; `MailJobHandler` passes
	 * `{ maxAttempts: 1 }` so queue-level and sync-level retries don't compound.
	 */
	async dispatchMessage(
		message: MailMessage,
		transportName?: string,
		overrideRetry?: RetryConfig,
		// The templates the message came from, when the caller still knows them.
		// A message revived from a queue payload does not: the rendered bodies
		// were serialised, the templates that produced them were not. Empty is
		// the honest answer there rather than a guess.
		views: MessageBodyTemplates = {},
	): Promise<MailResponse> {
		// Defense-in-depth: queue payloads bypass `#buildMessage`, so a
		// malformed message deserialised from storage would otherwise reach
		// the transport with the cryptic provider error A2 was meant to
		// eliminate. Cheap re-validation on every dispatch keeps the
		// failure mode uniform across send() and queue dequeue.
		validateMailMessage(message);
		const name = transportName ?? this.#defaultTransport;
		const t = this.#transports.get(name);
		if (!t) throw new Error(`Mail transport '${name}' not configured`);

		const retry = overrideRetry
			? resolveRetryConfig(undefined, overrideRetry)
			: resolveRetryConfig(this.#globalRetry, this.#transportRetry.get(name));

		const generatedId = randomBytes(16).toString("hex");
		let lastError: unknown;

		// Fire once before the first attempt — `mail:sending` signals intent, not
		// per-retry, matching @adonisjs/mail.
		this.#fireSending(this.#eventBase(message, views, name));

		for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
			let sendResult: MailSendOutcome;
			try {
				sendResult = await t.send(message);
			} catch (err) {
				lastError = err;
				const retryable = isRetryableError(err);
				if (!retryable || attempt === retry.maxAttempts) {
					const annotated = this.#withAttempts(err, attempt);
					this.#fireFailed({
						...this.#eventBase(message, views, name),
						messageId: generatedId,
						error: errorDescriptor(annotated, attempt),
					});
					throw annotated;
				}
				const delay = computeBackoffMs(attempt, retry, err);
				await new Promise((resolve) => setTimeout(resolve, delay));
				continue;
			}
			// Success path lives outside the try/catch so a throw inside the
			// success hook cannot be mistaken for a transport failure.
			const providerIdRaw = sendResult?.providerId;
			// `??` would accept empty-string providerId; explicit check so a
			// provider returning `{ providerId: "" }` falls back to the
			// internally generated correlation id.
			const providerId =
				typeof providerIdRaw === "string" && providerIdRaw.length > 0
					? providerIdRaw
					: undefined;
			const response = new MailResponse(
				providerId ?? generatedId,
				sendResult?.envelope ?? envelopeOf(message),
				sendResult?.original ?? sendResult,
			);
			this.#fireSent({
				...this.#eventBase(message, views, name),
				messageId: response.messageId,
				response,
			});
			return response;
		}
		// Unreachable — the loop always returns or throws — but TS wants a throw.
		throw lastError;
	}

	/**
	 * Return a shallow clone of `err` with `context.attempts` annotated. We
	 * avoid mutating the original error so outer retry layers / shared error
	 * references don't see their attempt counter overwritten.
	 */
	#withAttempts(err: unknown, attempts: number): unknown {
		if (!(err instanceof RoverError)) return err;
		const clone = new RoverError(err.code, err.message, {
			hint: err.hint,
			sourceFile: err.sourceFile,
			sourceLine: err.sourceLine,
			docsUrl: err.docsUrl,
			pipelineStage: err.pipelineStage,
			context: { ...err.context, attempts: String(attempts) },
		});
		if (err.stack) clone.stack = err.stack;
		return clone;
	}

	#fireSending(event: MailSendingEvent): void {
		this.#fire("mail:sending", event, this.#hooks.onSending);
	}

	#fireSent(event: MailSentEvent): void {
		this.#fire("mail:sent", event, this.#hooks.onSent);
	}

	#fireFailed(event: MailFailedEvent): void {
		this.#fire("mail:failed", event, this.#hooks.onFailed);
	}

	#fireQueueing(event: MailQueueEvent): void {
		this.#fire("mail:queueing", event, this.#hooks.onQueueing);
	}

	#fireQueued(event: MailQueueEvent): void {
		this.#fire("mail:queued", event, this.#hooks.onQueued);
	}

	/**
	 * Fan a lifecycle event out to the (optional, user-land, may-throw) hook and
	 * the (optional) event bus. Hook and bus failures are isolated: neither can
	 * poison the delivery outcome.
	 */
	#fire<T>(
		name: string,
		event: T,
		hook: ((event: T) => void) | undefined,
	): void {
		try {
			hook?.(event);
		} catch (err) {
			process.stderr.write(
				`[rover] ${name} hook threw: ${err instanceof Error ? err.message : String(err)}\n`,
			);
		}
		if (this.#emitter) {
			// Not just `try`: an Adonis-shaped emitter returns a promise, and a
			// listener that failed asynchronously rejected it with nobody to
			// catch — an unhandled rejection ending the process over a
			// notification, long after the mail itself went out fine.
			void (async () => this.#emitter?.emit(name, event))().catch(
				(err: unknown) => {
					process.stderr.write(
						`[rover] ${name} listener failed: ${err instanceof Error ? err.message : String(err)}\n`,
					);
				},
			);
		}
	}

	/**
	 * Build the message AND report which templates it was rendered from, since
	 * every lifecycle event carries both (AdonisJS `message` + `views`).
	 */
	async #buildMessageWithViews(
		arg: ((message: MessageBuilder) => void) | BaseMail,
	): Promise<{ message: MailMessage; views: MessageBodyTemplates }> {
		let result: MailMessage;
		let views: MessageBodyTemplates;
		if (arg instanceof BaseMail) {
			const built = await arg.build(this.#viewsRoot);
			result = built.from
				? built
				: { ...built, from: defaultSender(this.#defaultFrom) };
			views = arg.message.views;
		} else {
			const builder = new MessageBuilder();
			// An unset or blank default is left for validateMailMessage to
			// report as a missing sender, which is what it is.
			const from: MailAddress | undefined = this.#defaultFrom;
			if (typeof from === "string") {
				if (from.trim() !== "") builder.from(from);
			} else if (from !== undefined && from !== null) {
				builder.from(from.address, from.name);
			}
			arg(builder);
			result = await builder.build(this.#viewsRoot);
			views = builder.views;
		}
		validateMailMessage(result);
		return { message: result, views };
	}

	/**
	 * The fields every lifecycle event shares. One place, so `mail:sending` and
	 * `mail:sent` cannot describe the same message differently.
	 */
	#eventBase(
		message: MailMessage,
		views: MessageBodyTemplates,
		mailerName: string,
	): MailEventBase {
		return {
			mailerName,
			message,
			views,
			to: message.to.map(formatRecipient),
			cc: message.cc.map(formatRecipient),
			bcc: message.bcc.map(formatRecipient),
			transportName: mailerName,
			timestamp: Date.now(),
		};
	}

	/**
	 * Get a `Mailer` bound to a named transport, so `mail.use('mailgun').send(cb)`
	 * routes through that transport (Adonis parity). Mailers are cached per name.
	 */
	use(name: string): Mailer {
		this.#requireTransport(name);
		let mailer = this.#mailers.get(name);
		if (mailer === undefined) {
			mailer = new Mailer(this, name);
			this.#mailers.set(name, mailer);
		}
		return mailer;
	}

	/** @internal Resolve the raw transport instance behind a mailer name. */
	transportFor(name: string): MailTransport {
		return this.#requireTransport(name);
	}

	/** The transport behind `name`, or a RoverError listing the declared ones. */
	#requireTransport(name: string): MailTransport {
		const transport = this.#transports.get(name);
		if (transport) return transport;
		throw new RoverError(
			"E_MAIL_UNKNOWN_MAILER",
			`Mail mailer '${name}' is not declared in config.mailers`,
			{ hint: knownMailers(this.#transports) },
		);
	}

	/**
	 * Close one transport's open connections (Adonis `close`).
	 *
	 * An SMTP pool keeps sockets alive between sends; a process that exits
	 * without closing them leaves the server holding connections until it times
	 * them out. Unknown or already-closed names are a no-op — shutdown is not
	 * the place to throw.
	 */
	async close(name?: string): Promise<void> {
		const transportName = name ?? this.#defaultTransport;
		await this.#transports.get(transportName)?.close?.();
	}

	/** Close every built transport (Adonis `closeAll`). What a shutdown hook calls. */
	async closeAll(): Promise<void> {
		await Promise.all(
			[...this.#transports.values()].map((transport) => transport.close?.()),
		);
	}

	/**
	 * Enter fake mode. Every subsequent `send()` / `sendLater()` — including via
	 * `use(name)` — is captured by the returned `FakeMail` instead of hitting a
	 * transport or the queue. Call `restore()` to exit. Throws if already faking
	 * — nested fakes always indicate a forgotten `restore()`.
	 */
	fake(): FakeMail {
		if (this.#fake !== null) {
			throw new Error("Mail.fake() already active — call restore() first");
		}
		this.#fake = new FakeMail();
		return this.#fake;
	}

	/** Exit fake mode. No-op if not currently faking. */
	restore(): void {
		this.#fake = null;
	}
}

/**
 * A `Mailer` binds a named transport to the `send` / `sendLater` API so
 * `mail.use('mailgun').send(cb)` routes through that transport (Adonis parity).
 * It delegates back to the owning `Mail`, so fake mode and lifecycle events are
 * honoured uniformly.
 */
export class Mailer {
	#mail: Mail;
	#name: string;

	constructor(mail: Mail, name: string) {
		this.#mail = mail;
		this.#name = name;
	}

	/** The transport name this mailer is bound to. */
	get name(): string {
		return this.#name;
	}

	/** The underlying transport instance. */
	get transport(): MailTransport {
		return this.#mail.transportFor(this.#name);
	}

	send(
		arg: ((message: MessageBuilder) => void) | BaseMail,
	): Promise<MailResponse> {
		// Narrow so the overloaded `Mail.send` resolves without a union cast.
		return arg instanceof BaseMail
			? this.#mail.send(arg, this.#name)
			: this.#mail.send(arg, this.#name);
	}

	sendLater(
		arg: ((message: MessageBuilder) => void) | BaseMail,
		options?: { queue?: string },
	): Promise<string> {
		return this.#mail.sendLater(arg, { ...options, transport: this.#name });
	}
}

/**
 * Reject empty `from` and empty recipients before any transport is reached —
 * keeps the failure mode uniform across SMTP / Mailgun / SendGrid / SES /
 * Resend / log instead of relying on each transport to surface a (possibly
 * cryptic) "no recipients" provider error.
 */
function validateMailMessage(message: MailMessage): void {
	// `MailMessage.from` is typed, but config-loader paths and queue payloads
	// reach here untyped — a missing key can yield `undefined` despite the
	// type.
	if (
		message.from === undefined ||
		message.from === null ||
		(typeof message.from === "string" && message.from.trim() === "")
	) {
		throw new RoverError(
			"E_MAIL_INVALID_MESSAGE",
			"Mail message has no `from` address",
			{
				hint: "Set `config.from`, an instance `from`, or call `message.from(...)` in the builder.",
			},
		);
	}
	// Every address is re-checked here, not only in the builder: a queue
	// payload or a hand-built message never went through it, and a
	// `"a@x, b@y"` string would otherwise reach a parser that splits it.
	assertRecipient(message.from, "from address");
	// Defense-in-depth on each array: `MailJob.validatePayload` only requires
	// `to` to be an array (cc/bcc are optional at the queue boundary), so a
	// deserialised job payload may reach here with `cc`/`bcc` as `undefined`.
	let recipients = 0;
	for (const field of ["to", "cc", "bcc", "replyTo"] as const) {
		const list: unknown = message[field];
		if (list === undefined) continue;
		if (!Array.isArray(list)) {
			throw new RoverError(
				"E_MAIL_INVALID_MESSAGE",
				`Mail message \`${field}\` must be an array`,
			);
		}
		for (const entry of list) assertRecipient(entry, `${field} address`);
		if (field !== "replyTo") recipients += list.length;
	}
	if (message.envelope !== undefined) assertEnvelope(message.envelope);
	assertHeaders(message.headers);
	if (recipients === 0) {
		throw new RoverError(
			"E_MAIL_INVALID_MESSAGE",
			"Mail message has no recipients",
			{
				hint: "Call `message.to(...)`, `cc(...)`, or `bcc(...)` with a non-empty address before sending.",
			},
		);
	}
}

/**
 * The envelope a message will be sent with: its explicit `envelope()` when
 * set, otherwise the sender and every recipient, as nodemailer derives it.
 */
function envelopeOf(message: MailMessage): MailResponseEnvelope {
	const explicit = message.envelope;
	const list = (value: string | string[] | undefined): string[] =>
		value === undefined ? [] : Array.isArray(value) ? value : [value];
	if (explicit !== undefined) {
		return {
			from: explicit.from ?? recipientAddress(message.from),
			to: [...list(explicit.to), ...list(explicit.cc), ...list(explicit.bcc)],
		};
	}
	return {
		from: recipientAddress(message.from),
		to: [...message.to, ...message.cc, ...message.bcc].map(recipientAddress),
	};
}

function isEnvelope(value: unknown): value is MailResponseEnvelope {
	if (typeof value !== "object" || value === null) return false;
	const from: unknown = Reflect.get(value, "from");
	const to: unknown = Reflect.get(value, "to");
	return (
		(typeof from === "string" || from === false) &&
		Array.isArray(to) &&
		to.every((entry) => typeof entry === "string")
	);
}

/** The configured default sender in the stored shape. */
function defaultSender(from: MailAddress | undefined): Recipient {
	// Left empty for validateMailMessage to report as a missing sender.
	if (from === undefined || from === null) return "";
	if (typeof from === "string") return from.trim();
	return toRecipient(from.address, from.name);
}

function errorDescriptor(
	err: unknown,
	attempts: number,
): MailFailedEvent["error"] {
	if (err instanceof RoverError) {
		const statusStr = err.context.upstreamStatus;
		const upstream = Number(statusStr);
		return {
			code: err.code,
			message: err.message,
			upstreamStatus: Number.isFinite(upstream) ? upstream : undefined,
			upstreamStatusRaw: statusStr,
			attempts,
		};
	}
	if (err instanceof Error) {
		const errnoCode = (err as { code?: unknown }).code;
		return {
			code: typeof errnoCode === "string" ? errnoCode : "E_ROVER_UNKNOWN",
			message: err.message,
			attempts,
		};
	}
	return { code: "E_ROVER_UNKNOWN", message: String(err), attempts };
}

/** "Declared mailers: a, b." — the half of an unknown-mailer error that helps. */
function knownMailers(transports: Map<string, MailTransport>): string {
	const names = [...transports.keys()];
	return names.length > 0
		? `Declared mailers: ${names.join(", ")}.`
		: "No mailers are declared — add at least one to config.mailers.";
}
