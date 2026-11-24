/**
 * Rover errors, one class per code. An application branches on
 * `error.code` or on `error instanceof errors.E_…`; every one is a flare
 * `Exception`, with the HTTP status an exception handler answers with.
 *
 * `E_INVALID_CONFIG` and `E_MAIL_TRANSPORT_ERROR` are the mail library's own
 * errors, kept with its codes, class names and status. The other `E_MAIL_`
 * codes and `E_INVALID_LIST_HEADER`, `E_ATTACHMENT_UNREADABLE` predate the
 * `E_ROVER_` namespace and keep their spelling: applications already branch on
 * them.
 *
 * A failed message or fake-mailer assertion throws `AssertionError` from
 * `node:assert`, as the library does, not an error of this module.
 */

import { createError, Exception } from "@c9up/flare";

/** Options of the errors that carry a `context`. */
export interface ContextErrorOptions extends ErrorOptions {
	/** How to fix it, when the site knows. */
	help?: string;
}

/** A message lacks what sending needs, or holds a value it cannot carry. */
export const E_MAIL_INVALID_MESSAGE = createError<[string]>(
	"%s",
	"E_MAIL_INVALID_MESSAGE",
);

/** An address is not a single, header-safe mail address. */
export const E_MAIL_INVALID_ADDRESS = createError<[string]>(
	"%s",
	"E_MAIL_INVALID_ADDRESS",
);

/** A header name or value would break out of its header. */
export const E_MAIL_HEADER_INJECTION = createError<[string]>(
	"%s",
	"E_MAIL_HEADER_INJECTION",
);

/** A `List-*` entry is not one URL or bare address. */
export const E_INVALID_LIST_HEADER = createError<[string]>(
	"%s",
	"E_INVALID_LIST_HEADER",
);

/** An attachment's file, or a calendar event's URL, cannot be read. */
export const E_ATTACHMENT_UNREADABLE = createError<[string]>(
	"%s",
	"E_ATTACHMENT_UNREADABLE",
);

/**
 * One or more properties of a transport's config are missing or invalid.
 * Built as the library builds it: `new E_INVALID_CONFIG(message, { cause })`.
 */
export const E_INVALID_CONFIG = class InvalidConfigException extends Exception {
	static override status = 500;
	static override code = "E_INVALID_CONFIG";
};
export type E_INVALID_CONFIG = InstanceType<typeof E_INVALID_CONFIG>;

/** `icalEvent(callback)` needs `ical-generator`, which is missing or unusable. */
export const E_ROVER_ICAL_UNAVAILABLE = createError<[string]>(
	"%s",
	"E_ROVER_ICAL_UNAVAILABLE",
);

/** A retry setting is out of range. */
export const E_MAIL_RETRY_CONFIG = createError<[string, string, unknown]>(
	"RetryConfig.%s must be %s (got %s)",
	"E_MAIL_RETRY_CONFIG",
);

/** No `mail` config is registered. */
export class E_MAIL_CONFIG_MISSING extends Exception {
	static override code = "E_MAIL_CONFIG_MISSING";
	static override message =
		'Invalid "config/mail.ts" file: no `mail` config is registered.';
	static override help =
		"Create config/mail.ts with defineConfig(), or run `ream configure @c9up/rover`.";
}

/** A mailer name, or the default mailer, is not declared. */
export const E_MAIL_UNKNOWN_MAILER = createError<[string]>(
	"%s",
	"E_MAIL_UNKNOWN_MAILER",
);

/** A mailer names a transport that is not registered. */
export const E_MAIL_UNKNOWN_TRANSPORT = createError<[string, string]>(
	"Unknown mail transport type '%s' (configured under name '%s')",
	"E_MAIL_UNKNOWN_TRANSPORT",
);

/** A queued mail job's payload is missing or not a mail message. */
export const E_MAIL_JOB_MALFORMED = createError<[string]>(
	"%s",
	"E_MAIL_JOB_MALFORMED",
);

/** The app uses inker, but rover cannot render mail views with it. */
export const E_MAIL_TEMPLATE_ENGINE = createError<[string]>(
	"The app uses inker, but rover cannot render mail views with it: %s",
	"E_MAIL_TEMPLATE_ENGINE",
);

/** A mail template does not parse, or its data cannot reach the engine. */
export const E_MAIL_TEMPLATE_SYNTAX = createError<[string]>(
	"%s",
	"E_MAIL_TEMPLATE_SYNTAX",
);

/** Mail templates include each other in a cycle, or too deep. */
export const E_MAIL_TEMPLATE_RECURSION = createError<[string]>(
	"%s",
	"E_MAIL_TEMPLATE_RECURSION",
);

/** There is no rover native binary for this platform, or it failed to load. */
export const E_MAIL_TEMPLATE_NAPI_REQUIRED = createError<[string]>(
	"%s",
	"E_MAIL_TEMPLATE_NAPI_REQUIRED",
);

/** The `services/main` mail singleton was used before `RoverProvider` booted. */
export const E_ROVER_NOT_BOOTED = createError(
	"[rover] Mail singleton accessed before RoverProvider.boot() ran. Check that `@c9up/rover/provider` is listed in your reamrc.ts providers.",
	"E_ROVER_NOT_BOOTED",
);

/** `mail.fake()` was called while a fake is already active. */
export const E_ROVER_FAKE_ACTIVE = createError(
	"Mail.fake() already active — call restore() first",
	"E_ROVER_FAKE_ACTIVE",
);

/** A fake-mailer assertion got an empty `containing` needle. */
export const E_ROVER_INVALID_PREDICATE = createError(
	"FakeMail: `containing` predicate cannot be an empty string — it would match every captured message. Pass a non-empty needle.",
	"E_ROVER_INVALID_PREDICATE",
);

/** `BaseMail` was instantiated directly instead of through a subclass. */
export const E_ROVER_ABSTRACT_MAIL = createError(
	"BaseMail is abstract and cannot be instantiated directly",
	"E_ROVER_ABSTRACT_MAIL",
);

/** A webhook handler was created without its secret, public key or signing key. */
export const E_ROVER_WEBHOOK_KEY_MISSING = createError<
	[string, string, string]
>("%s: %s is required for %s verification.", "E_ROVER_WEBHOOK_KEY_MISSING");

/** The Resend webhook secret is not valid base64, or is too short. */
export const E_ROVER_WEBHOOK_INVALID_SECRET = createError<[string]>(
	"createResendWebhookHandler: %s",
	"E_ROVER_WEBHOOK_INVALID_SECRET",
);

/**
 * The SendGrid webhook's `publicKey` is not a public key, or not the ECDSA
 * P-256 key SendGrid signs its event webhook with.
 */
export const E_ROVER_WEBHOOK_INVALID_KEY = createError<[string]>(
	"createSendGridWebhookHandler: %s",
	"E_ROVER_WEBHOOK_INVALID_KEY",
);

/** An internal invariant broke; report it as a bug. */
export const E_ROVER_INTERNAL = createError<[string]>("%s", "E_ROVER_INTERNAL");

/** Options of `E_MAIL_TRANSPORT_ERROR`: the library's `cause`, plus `context` and `help`. */
export interface TransportErrorOptions extends ContextErrorOptions {
	/** What is known of the failure; see {@link E_MAIL_TRANSPORT_ERROR}. */
	context?: Readonly<Record<string, string>>;
}

/**
 * The transport failed to send: the library's error, built the way it builds
 * it, `new E_MAIL_TRANSPORT_ERROR(message, { cause })`.
 *
 * Added to it, `context` says what is known of the failure: `provider`,
 * `upstreamStatus` (HTTP status or SMTP reply code, `"0"` when none came
 * back), `providerMessage`, `networkCode` (an errno such as `ECONNRESET`),
 * `retryAfter` (seconds) and, once the send gave up, `attempts`. The retry
 * policy reads it.
 *
 * Deviation, named: the message is the site's own (`Resend returned 503`,
 * `SMTP failed: …`) rather than the library's fixed "Unable to send email
 * using the <name> transport", which drops the status and the errno a
 * reader needs to tell a throttle from an outage.
 */
export const E_MAIL_TRANSPORT_ERROR = class EmailTransportException extends Exception {
	static override status = 500;
	static override code = "E_MAIL_TRANSPORT_ERROR";

	readonly context: Readonly<Record<string, string>>;

	constructor(message: string, options?: TransportErrorOptions) {
		super(message, options);
		this.context = options?.context ?? {};
		if (options?.help !== undefined) this.help = options.help;
	}
};
export type E_MAIL_TRANSPORT_ERROR = InstanceType<
	typeof E_MAIL_TRANSPORT_ERROR
>;

/** The transport cannot set a field the message uses; `context` names both. */
export class E_MAIL_FIELD_UNSUPPORTED extends Exception {
	static override code = "E_MAIL_FIELD_UNSUPPORTED";

	constructor(
		message: string,
		public readonly context: Readonly<{ provider: string; field: string }>,
		options?: ContextErrorOptions,
	) {
		super(message, options);
		if (options?.help !== undefined) this.help = options.help;
	}
}

/** A mail template is not found; `context` holds the paths looked at. */
export class E_MAIL_TEMPLATE_NOT_FOUND extends Exception {
	static override code = "E_MAIL_TEMPLATE_NOT_FOUND";

	constructor(
		message: string,
		public readonly context: Readonly<Record<string, string>> = {},
		options?: ContextErrorOptions,
	) {
		super(message, options);
		if (options?.help !== undefined) this.help = options.help;
	}
}

/** A mail template exists but cannot be read; `context` holds the path and errno. */
export class E_MAIL_TEMPLATE_READ_ERROR extends Exception {
	static override code = "E_MAIL_TEMPLATE_READ_ERROR";

	constructor(
		message: string,
		public readonly context: Readonly<Record<string, string>>,
		options?: ContextErrorOptions,
	) {
		super(message, options);
		if (options?.help !== undefined) this.help = options.help;
	}
}
