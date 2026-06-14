import { randomBytes } from "node:crypto";
import nodemailer, { type Transporter } from "nodemailer";
import { BaseMail } from "./BaseMail.js";
import {
	type MailAttachment,
	type MailMessage,
	MessageBuilder,
} from "./MessageBuilder.js";
import {
	type BayQueueLike,
	MAIL_JOB_NAME,
	MailJobHandler,
} from "./queue/MailJob.js";
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
}

/**
 * Structural interface for the event bus `Emitter` — peer-dep friendly.
 * Rover never hard-imports the event bus.
 */
export interface EmitterLike {
	emit(event: string, data: unknown): void;
}

export interface MailSentEvent {
	messageId: string;
	to: string[];
	cc: string[];
	bcc: string[];
	transportName: string;
	timestamp: number;
}

export interface MailFailedEvent {
	messageId: string;
	to: string[];
	cc: string[];
	bcc: string[];
	transportName: string;
	error: {
		code: string;
		message: string;
		upstreamStatus?: number;
		upstreamStatusRaw?: string;
		attempts: number;
	};
	timestamp: number;
}

export interface MailConfig {
	default: string;
	from: string;
	transports: Record<
		string,
		{ transport: string; retry?: RetryConfig; [key: string]: unknown }
	>;
	/** Root directory for `htmlView(path, data)` template lookups. Default: `"resources/views/emails"`. */
	viewsRoot?: string;
	/** Optional Bay queue tuning for `sendLater()`. */
	queue?: { name?: string; maxAttempts?: number };
	/** Process-wide retry defaults. Overridden per-transport via `transports[name].retry`. */
	retry?: RetryConfig;
}

/**
 * Event hooks invoked by the internal dispatch loop. Default implementations
 * are no-ops; when an event-bus `EmitterLike` is wired, the hooks emit
 * `mail.sent` / `mail.failed`. Tests inject spies.
 */
export interface MailHooks {
	onSent?(event: MailSentEvent): void;
	onFailed?(event: MailFailedEvent): void;
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
				"MAIL_PROVIDER_CONFIG",
				`SMTP host must be a string, got ${typeof config.host}`,
				{ hint: "Set config.host to your SMTP server hostname." },
			);
		}
		if (typeof config.host !== "string" || config.host.length === 0) {
			throw new RoverError("MAIL_PROVIDER_CONFIG", "SMTP host is required", {
				hint: "Set config.host (e.g. process.env.SMTP_HOST). Use the fake / log transports for local development.",
			});
		}
		const host = config.host;
		const port = typeof config.port === "number" ? config.port : 587;
		const secure = typeof config.secure === "boolean" ? config.secure : false;
		const user = typeof config.user === "string" ? config.user : undefined;
		const pass = typeof config.pass === "string" ? config.pass : undefined;
		const requireTLS =
			typeof config.requireTLS === "boolean" ? config.requireTLS : undefined;
		// Partial auth config (only user OR only pass) is almost always a typo —
		// fail fast rather than connect anonymously and let the server reject.
		if ((user && !pass) || (!user && pass)) {
			throw new RoverError(
				"MAIL_PROVIDER_CONFIG",
				"SMTP auth requires both `user` and `pass` or neither",
				{
					hint: "Check your env vars — one half of the credential pair is missing.",
				},
			);
		}
		// Allow DI for tests: if the config carries a pre-built transporter,
		// use it instead of nodemailer.createTransport.
		const injected = config._transporter;
		if (injected && typeof injected === "object" && "sendMail" in injected) {
			this.#transporter = injected as Transporter;
		} else {
			this.#transporter = nodemailer.createTransport({
				host,
				port,
				secure,
				requireTLS,
				auth: user && pass ? { user, pass } : undefined,
			});
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
		try {
			const info = await this.#transporter.sendMail({
				from: message.from,
				to: message.to,
				cc: message.cc.length ? message.cc : undefined,
				bcc: message.bcc.length ? message.bcc : undefined,
				replyTo: message.replyTo,
				subject: message.subject,
				html: message.html,
				text: message.text,
				headers: Object.keys(message.headers).length
					? message.headers
					: undefined,
				attachments: message.attachments.length
					? message.attachments.map((att) => ({
							filename: att.filename,
							content: att.content,
							contentType: att.contentType,
						}))
					: undefined,
			});
			if (info.messageId) return { providerId: info.messageId };
			return undefined;
		} catch (err) {
			throw wrapSmtpError(err);
		}
	}
}

/**
 * Normalise nodemailer / socket errors into the uniform `MAIL_PROVIDER_ERROR`
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
		"MAIL_PROVIDER_ERROR",
		`SMTP failed: ${anyErr.message ?? "unknown"}`,
		{
			hint: "Inspect `context.networkCode` (ECONNRESET/ETIMEDOUT/...) or `context.upstreamStatus` (SMTP response code) to decide retry eligibility.",
			context: ctx,
		},
	);
}

/**
 * Log transport — logs emails to console (development).
 */
export class LogTransport implements MailTransport {
	async send(message: MailMessage): Promise<MailSendOutcome> {
		console.log(
			`[MAIL] To: ${message.to.join(", ")} | Subject: ${message.subject}`,
		);
		if (message.text) console.log(`  Body: ${message.text.slice(0, 200)}`);
		return undefined;
	}
}

export type MailTransportFactory = (
	config: Record<string, unknown>,
) => MailTransport;

const transportFactories: Record<string, MailTransportFactory> = {
	smtp: (config) => new SmtpTransport(config),
	log: () => new LogTransport(),
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
	#defaultTransport: string;
	#defaultFrom: string;
	#fakeSnapshot: { transportName: string; original: MailTransport } | null =
		null;
	#queue: BayQueueLike | null = null;
	#queueName: string;
	#queueMaxAttempts: number;
	#globalRetry: RetryConfig | undefined;
	#transportRetry: Map<string, RetryConfig> = new Map();
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
		this.#viewsRoot = config.viewsRoot;
		// Keep mutating the process-wide global too: standalone MessageBuilder
		// usage (not routed through this Mail) still reads it. The per-instance
		// #viewsRoot threaded into #buildMessage is what isolates Mail.send().
		if (config.viewsRoot !== undefined) {
			setViewsRoot(config.viewsRoot);
		}

		for (const [name, transportConfig] of Object.entries(config.transports)) {
			const factory = transportFactories[transportConfig.transport];
			if (!factory) {
				throw new RoverError(
					"MAIL_UNKNOWN_TRANSPORT",
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

		if (options?.queue) {
			this.#queue = options.queue;
			this.#queue.register(this.#queueName, new MailJobHandler(this));
		}
	}

	/** Send an email using the fluent message builder. */
	async send(
		callback: (message: MessageBuilder) => void,
		transport?: string,
	): Promise<void>;
	/** Send an email using a class-based `BaseMail` instance. */
	async send(instance: BaseMail, transport?: string): Promise<void>;
	async send(
		arg: ((message: MessageBuilder) => void) | BaseMail,
		transport?: string,
	): Promise<void> {
		const transportName = transport ?? this.#defaultTransport;
		// Validate transport up-front before running any callback / prepare() side effects.
		if (!this.#transports.has(transportName)) {
			throw new Error(`Mail transport '${transportName}' not configured`);
		}

		const message = await this.#buildMessage(arg);
		await this.dispatchMessage(message, transportName);
	}

	/**
	 * Enqueue a send onto the Bay queue. Returns the job id. Throws
	 * `MAIL_QUEUE_REQUIRED` if no `QueueManager` was wired through the
	 * constructor options.
	 */
	async sendLater(
		arg: ((message: MessageBuilder) => void) | BaseMail,
		options?: { transport?: string; queue?: string },
	): Promise<string> {
		if (this.#queue === null) {
			throw new RoverError(
				"MAIL_QUEUE_REQUIRED",
				"mail.sendLater() requires @c9up/bay QueueManager",
				{
					hint: "Register @c9up/bay and pass the QueueManager to Mail via RoverProvider, or use mail.send() for synchronous delivery.",
				},
			);
		}
		const message = await this.#buildMessage(arg);
		const queueName = options?.queue ?? this.#queueName;
		return this.#queue.dispatch(
			queueName,
			{ message, transport: options?.transport },
			{ maxAttempts: this.#queueMaxAttempts },
		);
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
	): Promise<void> {
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
						messageId: generatedId,
						to: message.to.slice(),
						cc: message.cc.slice(),
						bcc: message.bcc.slice(),
						transportName: name,
						error: errorDescriptor(annotated, attempt),
						timestamp: Date.now(),
					});
					throw annotated;
				}
				const delay = computeBackoffMs(attempt, retry, err);
				await new Promise((resolve) => setTimeout(resolve, delay));
				continue;
			}
			// Success path lives outside the try/catch so a throw inside the
			// success hook cannot be mistaken for a transport failure.
			const providerIdRaw =
				sendResult &&
				typeof sendResult === "object" &&
				"providerId" in sendResult
					? (sendResult.providerId as string | undefined)
					: undefined;
			// `??` would accept empty-string providerId; explicit truthy check
			// so a provider returning `{ providerId: "" }` falls back to the
			// internally generated correlation id.
			const providerId =
				providerIdRaw && providerIdRaw.length > 0 ? providerIdRaw : undefined;
			this.#fireSent({
				messageId: providerId ?? generatedId,
				to: message.to.slice(),
				cc: message.cc.slice(),
				bcc: message.bcc.slice(),
				transportName: name,
				timestamp: Date.now(),
			});
			return;
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

	#fireSent(event: MailSentEvent): void {
		// Hooks are in user-land and may throw; their failure must not poison
		// delivery outcome. Emitter errors are already defensively swallowed.
		try {
			this.#hooks.onSent?.(event);
		} catch (err) {
			process.stderr.write(
				`[rover] onSent hook threw: ${err instanceof Error ? err.message : String(err)}\n`,
			);
		}
		if (this.#emitter) {
			try {
				this.#emitter.emit("mail.sent", event);
			} catch {
				// Event bus failure ≠ mail delivery failure — swallow.
			}
		}
	}

	#fireFailed(event: MailFailedEvent): void {
		try {
			this.#hooks.onFailed?.(event);
		} catch (err) {
			process.stderr.write(
				`[rover] onFailed hook threw: ${err instanceof Error ? err.message : String(err)}\n`,
			);
		}
		if (this.#emitter) {
			try {
				this.#emitter.emit("mail.failed", event);
			} catch {
				// Event bus failure ≠ mail delivery failure — swallow.
			}
		}
	}

	async #buildMessage(
		arg: ((message: MessageBuilder) => void) | BaseMail,
	): Promise<MailMessage> {
		let result: MailMessage;
		if (arg instanceof BaseMail) {
			const built = await arg.build(this.#viewsRoot);
			result = built.from ? built : { ...built, from: this.#defaultFrom };
		} else {
			const builder = new MessageBuilder();
			builder.from(this.#defaultFrom);
			arg(builder);
			result = await builder.build(this.#viewsRoot);
		}
		validateMailMessage(result);
		return result;
	}

	/** Get a specific transport. */
	use(name: string): MailTransport {
		const t = this.#transports.get(name);
		if (!t) throw new Error(`Mail transport '${name}' not configured`);
		return t;
	}

	/**
	 * Swap the default transport with a `FakeMail` that captures every send.
	 * Call `restore()` to re-install the original. Throws if a fake is already
	 * active — nested fakes always indicate a forgotten `restore()`.
	 */
	fake(): FakeMail {
		if (this.#fakeSnapshot !== null) {
			throw new Error("Mail.fake() already active — call restore() first");
		}
		const transportName = this.#defaultTransport;
		const original = this.#transports.get(transportName);
		if (!original) {
			throw new Error(
				`Cannot fake default transport '${transportName}' — not configured`,
			);
		}
		const fake = new FakeMail();
		this.#fakeSnapshot = { transportName, original };
		this.#transports.set(transportName, fake);
		return fake;
	}

	/** Undo the swap installed by `fake()`. No-op if no fake is active. */
	restore(): void {
		if (this.#fakeSnapshot === null) return;
		const { transportName, original } = this.#fakeSnapshot;
		this.#transports.set(transportName, original);
		this.#fakeSnapshot = null;
	}
}

/**
 * Reject empty `from` and empty recipients before any transport is reached —
 * keeps the failure mode uniform across SMTP / Mailgun / SendGrid / SES /
 * Resend / log instead of relying on each transport to surface a (possibly
 * cryptic) "no recipients" provider error.
 */
function validateMailMessage(message: MailMessage): void {
	// `MailMessage.from` is typed `string` but config-loader paths
	// (`app.config.get<MailConfig>(...)`) cast at runtime — a missing key
	// can yield `undefined` despite the type. Whitespace-only is also
	// invalid per RFC 5321 reverse-path semantics.
	if (typeof message.from !== "string" || message.from.trim() === "") {
		throw new RoverError(
			"MAIL_INVALID_MESSAGE",
			"Mail message has no `from` address",
			{
				hint: "Set `config.from`, an instance `from`, or call `message.from(...)` in the builder.",
			},
		);
	}
	// Defense-in-depth on each array: `MailJob.validatePayload` only requires
	// `to` to be an array (cc/bcc are optional at the queue boundary), so a
	// deserialised job payload may reach here with `cc`/`bcc` as `undefined`.
	// `.some(...)` on `undefined` throws `TypeError` instead of the
	// structured `MAIL_INVALID_MESSAGE` this validator is supposed to surface.
	const hasRecipient =
		(Array.isArray(message.to) && message.to.some(isNonEmptyAddress)) ||
		(Array.isArray(message.cc) && message.cc.some(isNonEmptyAddress)) ||
		(Array.isArray(message.bcc) && message.bcc.some(isNonEmptyAddress));
	if (!hasRecipient) {
		throw new RoverError(
			"MAIL_INVALID_MESSAGE",
			"Mail message has no recipients",
			{
				hint: "Call `message.to(...)`, `cc(...)`, or `bcc(...)` with a non-empty address before sending.",
			},
		);
	}
}

function isNonEmptyAddress(addr: unknown): boolean {
	return typeof addr === "string" && addr.trim() !== "";
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
			code: typeof errnoCode === "string" ? errnoCode : "UNKNOWN",
			message: err.message,
			attempts,
		};
	}
	return { code: "UNKNOWN", message: String(err), attempts };
}
