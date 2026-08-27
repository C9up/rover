import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { formatAddress } from "./format.js";
import { RoverError } from "./RoverError.js";
import { renderFile as renderTemplateFile } from "./templating/SimpleTemplate.js";

/**
 * A header nodemailer must pass through untouched (`{ prepared: true }`).
 *
 * Normal headers get re-encoded — folded, MIME-encoded when non-ASCII. A value
 * that is already exactly what must go on the wire (a signature, a
 * pre-encoded id) has to say so, or the encoding corrupts it.
 */
export interface PreparedHeader {
	prepared: true;
	value: string;
}

/**
 * A header value as a plain string, for the HTTP-API transports.
 *
 * "Prepared" is a nodemailer notion — it tells its MIME encoder to leave the
 * value alone. A provider REST API takes a JSON string and does no MIME
 * encoding, so the flag has nothing to say there; sending the wrapper object
 * would put `[object Object]` on the wire.
 */
export function headerValue(
	value: string | string[] | PreparedHeader,
): string | string[] {
	if (Array.isArray(value) || typeof value === "string") return value;
	return value.value;
}

export interface MailMessage {
	from: string;
	to: string[];
	cc: string[];
	bcc: string[];
	replyTo?: string;
	subject: string;
	html?: string;
	text?: string;
	/**
	 * The Apple Watch body (nodemailer `watchHtml`). A stripped-down HTML part
	 * a watch renders instead of the full one.
	 */
	watchHtml?: string;
	attachments: MailAttachment[];
	headers: Record<string, string | string[] | PreparedHeader>;
	/** Email priority hint (nodemailer `priority`). */
	priority?: "low" | "normal" | "high";
	/** Custom `Message-ID` header (threading / idempotency). */
	messageId?: string;
	/** `In-Reply-To` header — the message id this email replies to. */
	inReplyTo?: string;
	/** `References` header — the thread's message ids. */
	references?: string[];
	/** SMTP envelope, when it differs from the visible From/To headers. */
	envelope?: MailEnvelope;
	/** Body transfer encoding (nodemailer `encoding`). SMTP only. */
	encoding?: string;
	/** RFC 2369 `List-*` headers, keyed WITHOUT the `List-` prefix. */
	list?: Record<string, ListHeader | ListHeader[] | ListHeader[][]>;
	/** A calendar invitation carried as `text/calendar` (nodemailer `icalEvent`). */
	icalEvent?: CalendarEvent;
}

/**
 * One `List-*` header value: a bare URL, or a URL with a human comment.
 *
 * `comment` is REQUIRED in the object form, as it is in nodemailer and
 * AdonisJS — a URL without a comment is the bare string form.
 */
export type ListHeader = string | { url: string; comment: string };

/** How the receiving client should treat the invitation (RFC 5546). */
export type CalendarEventMethod =
	| "PUBLISH"
	| "REQUEST"
	| "REPLY"
	| "ADD"
	| "CANCEL"
	| "REFRESH"
	| "COUNTER"
	| "DECLINECOUNTER";

/** Options shared by the three `icalEvent*` forms (AdonisJS `CalendarEventOptions`). */
export interface CalendarEventOptions {
	method?: CalendarEventMethod;
	filename?: string;
	encoding?: string;
}

/**
 * A calendar invitation. Exactly one source: inline `content`, a `path` read at
 * {@link MessageBuilder.build} time, or an `href` the provider fetches.
 */
export interface CalendarEvent extends CalendarEventOptions {
	content?: string;
	path?: string;
	href?: string;
}

/** The addresses the mail SERVERS use, as distinct from the visible headers. */
export interface MailEnvelope {
	from?: string;
	to?: string | string[];
	cc?: string | string[];
	bcc?: string | string[];
}

export interface MailAttachment {
	filename: string;
	content: Buffer | string;
	contentType?: string;
	/** Content-ID for inline (CID) embedding — set via `embed()` / `embedData()`. */
	cid?: string;
	/** Source path, kept so `hasAttachment(file)` can answer by path. */
	path?: string;
	/** `Content-Disposition`, when it is not the default for the form used. */
	contentDisposition?: "attachment" | "inline";
	/** `Content-Transfer-Encoding` for this part. */
	encoding?: string;
	/** Extra part headers. */
	headers?: Record<string, string | string[]>;
}

/** What the `attach*` / `embed*` methods accept (AdonisJS `AttachmentOptions`). */
export interface AttachmentOptions {
	filename?: string;
	contentType?: string;
	contentDisposition?: "attachment" | "inline";
	encoding?: string;
	headers?: Record<string, string | string[]>;
}

/**
 * A recipient in object form (Adonis parity). `name` is optional and, when
 * present, produces the `"Name" <address>` display form.
 */
export interface RecipientObject {
	address: string;
	name?: string;
}

export type Recipient = string | RecipientObject;

/** Whether `list` holds `address`, or anything at all when it is omitted. */
function contains(
	list: readonly string[],
	address?: string,
	name?: string,
): boolean {
	if (address === undefined) return list.length > 0;
	// With a name, both halves must match — the entry was stored through
	// `formatAddress`, so rebuilding it is the exact comparison (AdonisJS
	// checks address AND name the same way).
	if (name !== undefined) {
		const formatted = formatAddress(address, name);
		return list.some((entry) => entry === formatted);
	}
	// Addresses are stored formatted (`"Name" <a@b.c>`), so an assertion on the
	// bare address has to match inside the display form too.
	return list.some(
		(entry) => entry === address || entry.includes(`<${address}>`),
	);
}

/**
 * The parts a transport with no calendar field must send: the declared
 * attachments, plus the invitation rendered as a `text/calendar` part.
 *
 * Only nodemailer has a native `icalEvent`; the provider HTTP APIs carry an
 * invitation the way every mail client reads it anyway — as an attachment with
 * the right media type and `method` parameter.
 */
export function attachmentsFor(message: MailMessage): MailAttachment[] {
	const ical = message.icalEvent;
	if (ical === undefined) return message.attachments;
	if (ical.content === undefined) {
		// `icalEventFromUrl` leaves only an href, which nodemailer fetches for
		// SMTP. An HTTP provider takes the bytes, and silently dropping the
		// invitation would be worse than saying so.
		throw new RoverError(
			"ICAL_HREF_UNSUPPORTED",
			"icalEventFromUrl() is only supported by the SMTP transport, which fetches the URL itself.",
			{
				hint: "Fetch the ICS yourself and pass it to icalEvent(contents), or use icalEventFromFile().",
			},
		);
	}
	const method = ical.method ?? "PUBLISH";
	return [
		...message.attachments,
		{
			filename: ical.filename ?? "invite.ics",
			content: ical.content,
			contentType: `text/calendar; charset=utf-8; method=${method}`,
			encoding: ical.encoding,
		},
	];
}

/** Read a file declared by `attach()` / `embed()` / `icalEventFromFile()`. */
async function readAttachment(path: string, label: string): Promise<Buffer> {
	try {
		return await readFile(path);
	} catch (err) {
		throw new RoverError(
			"ATTACHMENT_UNREADABLE",
			`Could not read ${label} from "${path}": ${err instanceof Error ? err.message : String(err)}`,
			{
				hint: "Give an absolute path, or attach the bytes with attachData() / embedData().",
			},
		);
	}
}

/** Every URL inside a `List-*` value, whatever nesting form it was written in. */
function listUrls(value: ListHeader | ListHeader[] | ListHeader[][]): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap((entry) => listUrls(entry));
	return [value.url];
}

/** `unsubscribe` → `Unsubscribe`, `unsubscribe-post` → `Unsubscribe-Post`. */
function titleCaseKey(key: string): string {
	return key
		.split("-")
		.map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
		.join("-");
}

/** Render one `List-*` value the way RFC 2369 writes it: `<url> (comment)`. */
function renderListHeader(
	value: ListHeader | ListHeader[] | ListHeader[][],
): string {
	if (typeof value === "string") return `<${value}>`;
	if (Array.isArray(value)) {
		return value.map((entry) => renderListHeader(entry)).join(", ");
	}
	return value.comment ? `<${value.url}> (${value.comment})` : `<${value.url}>`;
}

function expect(passed: boolean, expectation: string, actual: unknown): void {
	if (passed) return;
	throw new RoverError(
		"ASSERTION_FAILED",
		`Expected the message ${expectation}, got ${JSON.stringify(actual)}`,
	);
}

/**
 * Which templates a message was rendered from — AdonisJS
 * `MessageBodyTemplates`, carried on every mail lifecycle event.
 */
export interface MessageBodyTemplates {
	html?: { template: string; data: Record<string, unknown> };
	text?: { template: string; data: Record<string, unknown> };
}

export class MessageBuilder {
	#msg: MailMessage = {
		from: "",
		to: [],
		cc: [],
		bcc: [],
		subject: "",
		attachments: [],
		headers: {},
	};
	#pendingView: { path: string; data: Record<string, unknown> } | null = null;
	/**
	 * The templates {@link build} actually rendered. Recorded because `build()`
	 * clears the pending views once they are rendered, and the lifecycle events
	 * carry them (AdonisJS `views`, the third field of every mail event) — an
	 * app logging a send wants to know which template produced it.
	 */
	#renderedViews: MessageBodyTemplates = {};
	#pendingTextView: { path: string; data: Record<string, unknown> } | null =
		null;

	/**
	 * Render a template as the PLAIN-TEXT body (AdonisJS `textView`).
	 *
	 * The counterpart of `htmlView`. A message with only an HTML part scores
	 * worse with spam filters and is unreadable in a text-only client, which is
	 * why upstream offers both.
	 */
	textView(path: string, data: Record<string, unknown> = {}): this {
		this.#pendingTextView = { path, data };
		return this;
	}

	/**
	 * Override the SMTP envelope — who the message is really from and to, as
	 * far as the mail servers are concerned (AdonisJS `envelope`).
	 *
	 * Distinct from the `From`/`To` HEADERS: a bounce goes to the envelope
	 * sender, which is how VERP and mailing lists route failures away from the
	 * visible author.
	 */
	envelope(envelope: MailEnvelope): this {
		this.#msg.envelope = envelope;
		return this;
	}

	/**
	 * The message as built so far — what the `has*` / `assert*` helpers read.
	 *
	 * Exposed because a test asserts against a mail it never sent, and the
	 * alternative is rebuilding the message just to look at it.
	 */
	toObject(): Readonly<MailMessage> {
		return this.#msg;
	}

	toJSON(): Readonly<MailMessage> {
		return this.toObject();
	}

	// ── Inspection ────────────────────────────────────────────────────────
	// `has*` answers, `assert*` throws. Both exist because a test reads better
	// as an assertion and a conditional reads better as a question.

	hasTo(address?: string, name?: string): boolean {
		return contains(this.#msg.to, address, name);
	}
	hasCc(address?: string, name?: string): boolean {
		return contains(this.#msg.cc, address, name);
	}
	hasBcc(address?: string, name?: string): boolean {
		return contains(this.#msg.bcc, address, name);
	}
	hasFrom(address?: string, name?: string): boolean {
		return contains(this.#msg.from ? [this.#msg.from] : [], address, name);
	}
	hasReplyTo(address?: string, name?: string): boolean {
		return contains(
			this.#msg.replyTo ? [this.#msg.replyTo] : [],
			address,
			name,
		);
	}
	hasSubject(subject?: string): boolean {
		if (subject === undefined) return this.#msg.subject !== "";
		return this.#msg.subject === subject;
	}
	/**
	 * Whether the message carries an attachment — any at all, one with this
	 * filename or source path, or one a predicate accepts (AdonisJS
	 * `hasAttachment`, whose overloads are the same three).
	 */
	hasAttachment(
		match?: string | URL | ((attachment: MailAttachment) => boolean),
	): boolean {
		if (match === undefined) return this.#msg.attachments.length > 0;
		if (typeof match === "function") return this.#msg.attachments.some(match);
		const needle = match instanceof URL ? fileURLToPath(match) : match;
		return this.#msg.attachments.some(
			(a) => a.filename === needle || a.path === needle,
		);
	}

	/**
	 * Whether `address` appears in ONE named field (AdonisJS `hasRecipient`).
	 *
	 * The field comes first, as upstream: `hasRecipient('to', 'a@b.c')`. It used
	 * to take the address alone and search every field, so a migrated
	 * `hasRecipient('to', addr)` asked whether `'to'` was a recipient and quietly
	 * answered false — the worst possible outcome inside a test assertion.
	 * {@link hasAnyRecipient} is the any-field question under a name that says so.
	 */
	hasRecipient(
		property: "to" | "cc" | "bcc" | "replyTo",
		address: string,
		name?: string,
	): boolean {
		switch (property) {
			case "to":
				return this.hasTo(address, name);
			case "cc":
				return this.hasCc(address, name);
			case "bcc":
				return this.hasBcc(address, name);
			case "replyTo":
				return this.hasReplyTo(address, name);
		}
	}

	/**
	 * Whether `address` is a recipient in any of `to` / `cc` / `bcc`. Without
	 * one, whether the message has a recipient at all. Ream's own, since
	 * "does this reach them" is the question an assertion usually asks.
	 */
	hasAnyRecipient(address?: string, name?: string): boolean {
		return (
			this.hasTo(address, name) ||
			this.hasCc(address, name) ||
			this.hasBcc(address, name)
		);
	}

	/**
	 * Whether the given text appears in the HTML body or the plain-text one
	 * (AdonisJS `hasContent`). The field-specific assertions are
	 * {@link assertHtmlIncludes} and {@link assertTextIncludes}.
	 */
	hasContent(needle: string): boolean {
		return (
			(this.#msg.html?.includes(needle) ?? false) ||
			(this.#msg.text?.includes(needle) ?? false)
		);
	}

	/** Whether a `List-<key>` header was defined. */
	hasListHeader(key: string, url?: string): boolean {
		const value = this.#msg.list?.[key];
		if (value === undefined) return false;
		if (url === undefined) return true;
		return listUrls(value).includes(url);
	}
	hasHeader(name: string, value?: string): boolean {
		const found = this.#msg.headers[name];
		if (found === undefined) return false;
		if (value === undefined) return true;
		return Array.isArray(found) ? found.includes(value) : found === value;
	}

	assertTo(address: string): void {
		expect(this.hasTo(address), `to include "${address}"`, this.#msg.to);
	}
	assertFrom(address: string): void {
		expect(this.hasFrom(address), `from to be "${address}"`, this.#msg.from);
	}
	assertCc(address: string): void {
		expect(this.hasCc(address), `cc to include "${address}"`, this.#msg.cc);
	}
	assertBcc(address: string): void {
		expect(this.hasBcc(address), `bcc to include "${address}"`, this.#msg.bcc);
	}
	assertReplyTo(address: string): void {
		expect(
			this.hasReplyTo(address),
			`replyTo to be "${address}"`,
			this.#msg.replyTo,
		);
	}
	assertSubject(subject: string): void {
		expect(
			this.hasSubject(subject),
			`subject to be "${subject}"`,
			this.#msg.subject,
		);
	}
	assertAttachment(
		match: string | URL | ((attachment: MailAttachment) => boolean),
	): void {
		expect(
			this.hasAttachment(match),
			typeof match === "function"
				? "an attachment matching the predicate"
				: `an attachment named "${String(match)}"`,
			this.#msg.attachments.map((a) => a.path ?? a.filename),
		);
	}

	/** `address` is a recipient in some field (AdonisJS `assertRecipient`). */
	assertRecipient(address: string): void {
		expect(this.hasAnyRecipient(address), `to reach "${address}"`, {
			to: this.#msg.to,
			cc: this.#msg.cc,
			bcc: this.#msg.bcc,
		});
	}

	/** The text appears in the HTML or the plain-text body (AdonisJS `assertContent`). */
	assertContent(needle: string): void {
		expect(this.hasContent(needle), `to contain "${needle}"`, {
			html: this.#msg.html,
			text: this.#msg.text,
		});
	}
	assertHeader(name: string, value?: string): void {
		expect(
			this.hasHeader(name, value),
			value === undefined ? `a "${name}" header` : `${name}: ${value}`,
			this.#msg.headers[name],
		);
	}
	assertHtmlIncludes(substring: string): void {
		expect(
			(this.#msg.html ?? "").includes(substring),
			`html to include "${substring}"`,
			this.#msg.html,
		);
	}
	assertTextIncludes(substring: string): void {
		expect(
			(this.#msg.text ?? "").includes(substring),
			`text to include "${substring}"`,
			this.#msg.text,
		);
	}

	from(address: string, name?: string): this {
		this.#msg.from = formatAddress(address, name);
		return this;
	}

	to(address: string, name?: string): this;
	to(addresses: Recipient[]): this;
	to(address: string | Recipient[], name?: string): this {
		addRecipients(this.#msg.to, address, name);
		return this;
	}

	cc(address: string, name?: string): this;
	cc(addresses: Recipient[]): this;
	cc(address: string | Recipient[], name?: string): this {
		addRecipients(this.#msg.cc, address, name);
		return this;
	}

	bcc(address: string, name?: string): this;
	bcc(addresses: Recipient[]): this;
	bcc(address: string | Recipient[], name?: string): this {
		addRecipients(this.#msg.bcc, address, name);
		return this;
	}

	replyTo(address: string, name?: string): this {
		this.#msg.replyTo = formatAddress(address, name);
		return this;
	}

	subject(text: string): this {
		this.#msg.subject = text;
		return this;
	}
	html(content: string): this {
		this.#msg.html = content;
		return this;
	}

	/**
	 * The Apple Watch body (AdonisJS `watch`).
	 *
	 * NAMED DEVIATION — this writes nodemailer's `watchHtml`. AdonisJS writes a
	 * bare `watch` field, which nodemailer's mail composer never reads
	 * (lib/mail-composer/index.js only looks at `watchHtml`), so upstream's
	 * watch body never reaches the wire. {@link watchHtml} is the same method
	 * under the field's own name.
	 */
	watch(content: string): this {
		return this.watchHtml(content);
	}

	watchHtml(content: string): this {
		this.#msg.watchHtml = content;
		return this;
	}
	text(content: string): this {
		this.#msg.text = content;
		return this;
	}

	/** Email priority (`low` | `normal` | `high`). */
	priority(priority: "low" | "normal" | "high"): this {
		this.#msg.priority = priority;
		return this;
	}

	/** Set a custom `Message-ID` header. */
	messageId(messageId: string): this {
		this.#msg.messageId = messageId;
		return this;
	}

	/** Set the `In-Reply-To` header for threading replies. */
	inReplyTo(messageId: string): this {
		this.#msg.inReplyTo = messageId;
		return this;
	}

	/** Set the `References` header (thread message ids). */
	references(messageIds: string[]): this {
		this.#msg.references = messageIds.slice();
		return this;
	}

	/**
	 * Attach a FILE by path or `file://` URL (AdonisJS `attach`). The bytes are
	 * read at {@link build} time, so the fluent chain stays synchronous.
	 *
	 * The filename defaults to the file's own basename. For bytes you already
	 * hold, use {@link attachData}.
	 */
	attach(file: string | URL, options?: AttachmentOptions): this {
		const path = file instanceof URL ? fileURLToPath(file) : file;
		this.#msg.attachments.push({
			filename: options?.filename ?? basename(path),
			// Filled in by `build()`; an unread attachment must never ship as an
			// empty part, so `build()` failing to read is an error, not a warning.
			content: "",
			path,
			contentType: options?.contentType,
			contentDisposition: options?.contentDisposition,
			encoding: options?.encoding,
			headers: options?.headers,
		});
		return this;
	}

	/**
	 * Attach bytes you already hold (AdonisJS `attachData`). `filename` is
	 * required — there is no path to take it from.
	 */
	attachData(
		content: Buffer | string,
		options: AttachmentOptions & { filename: string },
	): this {
		this.#msg.attachments.push({
			filename: options.filename,
			content,
			contentType: options.contentType,
			contentDisposition: options.contentDisposition,
			encoding: options.encoding,
			headers: options.headers,
		});
		return this;
	}

	/**
	 * Embed a FILE inline, referenced by `cid:<cid>` in the HTML body (AdonisJS
	 * `embed`). Read at {@link build} time, like {@link attach}.
	 */
	embed(file: string | URL, cid: string, options?: AttachmentOptions): this {
		const path = file instanceof URL ? fileURLToPath(file) : file;
		this.#msg.attachments.push({
			filename: options?.filename ?? basename(path),
			content: "",
			path,
			cid,
			contentType: options?.contentType,
			contentDisposition: options?.contentDisposition ?? "inline",
			encoding: options?.encoding,
			headers: options?.headers,
		});
		return this;
	}

	/**
	 * Embed bytes you already hold, referenced by `cid:<cid>` in the HTML body
	 * (AdonisJS `embedData`).
	 */
	embedData(
		content: Buffer | string,
		cid: string,
		options?: AttachmentOptions,
	): this {
		this.#msg.attachments.push({
			filename: options?.filename ?? cid,
			content,
			cid,
			contentType: options?.contentType,
			contentDisposition: options?.contentDisposition ?? "inline",
			encoding: options?.encoding,
			headers: options?.headers,
		});
		return this;
	}

	header(key: string, value: string | string[]): this {
		this.#msg.headers[key] = value;
		return this;
	}

	/**
	 * A header nodemailer passes through untouched (AdonisJS `preparedHeader`).
	 *
	 * Use it when the value IS what must appear on the wire and re-encoding
	 * would corrupt it — a signature, an already-encoded message id.
	 */
	preparedHeader(key: string, value: string): this {
		this.#msg.headers[key] = { prepared: true, value };
		return this;
	}

	/**
	 * Body transfer encoding (AdonisJS `encoding`) — `7bit`, `base64`,
	 * `quoted-printable`… SMTP only: the provider HTTP APIs encode the payload
	 * themselves and expose no equivalent.
	 */
	encoding(encoding: string): this {
		this.#msg.encoding = encoding;
		return this;
	}

	// ── RFC 2369 List-* headers ───────────────────────────────────────────

	/**
	 * Define a `List-<key>` header (AdonisJS `addListHeader`). `key` carries no
	 * `List-` prefix — `addListHeader('archive', url)` emits `List-Archive`.
	 * Calling it again for the same key replaces the value.
	 */
	addListHeader(
		key: string,
		value: ListHeader | ListHeader[] | ListHeader[][],
	): this {
		this.#msg.list ??= {};
		this.#msg.list[key] = value;
		return this;
	}

	/**
	 * `List-Unsubscribe` (AdonisJS `listUnsubscribe`).
	 *
	 * `{ oneClick: true }` also emits the RFC 8058 `List-Unsubscribe-Post`
	 * header. Gmail and Yahoo require BOTH for bulk senders, and only a `https:`
	 * URL is a valid one-click target — a `mailto:` cannot answer a POST, so
	 * pairing them is refused rather than silently shipped.
	 */
	listUnsubscribe(
		value: ListHeader | ListHeader[] | ListHeader[][],
		options?: { oneClick?: boolean },
	): this {
		if (options?.oneClick === true) {
			for (const url of listUrls(value)) {
				if (!url.toLowerCase().startsWith("http")) {
					throw new RoverError(
						"INVALID_LIST_HEADER",
						`listUnsubscribe({ oneClick: true }) needs an https URL that can answer a POST, got "${url}".`,
						{
							hint: "Keep the mailto: form without oneClick, or add an https endpoint alongside it.",
						},
					);
				}
			}
			// A RAW header, not a `List-*` entry: nodemailer wraps every list value
			// in angle brackets, and `<List-Unsubscribe=One-Click>` is not what
			// RFC 8058 specifies — receivers would ignore it.
			this.#msg.headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
		}
		return this.addListHeader("unsubscribe", value);
	}

	/** `List-Subscribe` (AdonisJS `listSubscribe`). */
	listSubscribe(value: ListHeader | ListHeader[] | ListHeader[][]): this {
		return this.addListHeader("subscribe", value);
	}

	/** `List-Help` (AdonisJS `listHelp`). */
	listHelp(value: ListHeader | ListHeader[] | ListHeader[][]): this {
		return this.addListHeader("help", value);
	}

	// ── Calendar invitations ──────────────────────────────────────────────

	/**
	 * Attach a calendar invitation from an ICS string (AdonisJS `icalEvent`).
	 *
	 * Named deviation: upstream also accepts a `(calendar: ICalCalendar) => void`
	 * builder, which is `ical-generator`'s API. rover carries no such
	 * dependency, so it takes the ICS text — produced by whichever generator you
	 * prefer. {@link icalEventFromFile} and {@link icalEventFromUrl} are the
	 * other two upstream forms, unchanged.
	 */
	icalEvent(contents: string, options?: CalendarEventOptions): this {
		this.#msg.icalEvent = { ...options, content: contents };
		return this;
	}

	/** Calendar invitation read from a file at {@link build} time (AdonisJS `icalEventFromFile`). */
	icalEventFromFile(file: string | URL, options?: CalendarEventOptions): this {
		this.#msg.icalEvent = {
			...options,
			path: file instanceof URL ? fileURLToPath(file) : file,
		};
		return this;
	}

	/** Calendar invitation the transport fetches from a URL (AdonisJS `icalEventFromUrl`). */
	icalEventFromUrl(url: string, options?: CalendarEventOptions): this {
		this.#msg.icalEvent = { ...options, href: url };
		return this;
	}

	/**
	 * Queue an HTML template render. The render happens lazily at `build()` time
	 * so the fluent chain stays synchronous; `build()` is async and awaits the
	 * render before returning the finalised `MailMessage`.
	 */
	htmlView(viewPath: string, data?: Record<string, unknown>): this {
		this.#pendingView = { path: viewPath, data: data ?? {} };
		return this;
	}

	/** The templates {@link build} rendered, for the lifecycle events. */
	get views(): MessageBodyTemplates {
		return { ...this.#renderedViews };
	}

	/**
	 * Finalise the message. `viewsRoot`, when provided by the owning `Mail`,
	 * scopes template resolution to that instance's configured root instead of
	 * the process-wide mutable global — so two `Mail`s with different roots no
	 * longer clobber each other.
	 */
	async build(viewsRoot?: string): Promise<MailMessage> {
		if (this.#pendingView !== null) {
			this.#renderedViews.html = {
				template: this.#pendingView.path,
				data: this.#pendingView.data,
			};
			this.#msg.html = await renderTemplateFile(
				this.#pendingView.path,
				this.#pendingView.data,
				undefined,
				viewsRoot,
			);
			this.#pendingView = null;
		}
		if (this.#pendingTextView !== null) {
			this.#renderedViews.text = {
				template: this.#pendingTextView.path,
				data: this.#pendingTextView.data,
			};
			this.#msg.text = await renderTemplateFile(
				this.#pendingTextView.path,
				this.#pendingTextView.data,
				undefined,
				viewsRoot,
			);
			this.#pendingTextView = null;
		}
		// Path-based attachments and invitations are read here, not when they were
		// declared, so the fluent chain stays synchronous. A read failure raises:
		// an attachment the recipient expects must never ship as an empty part.
		for (const attachment of this.#msg.attachments) {
			if (attachment.path === undefined) continue;
			attachment.content = await readAttachment(
				attachment.path,
				attachment.filename,
			);
		}
		const ical = this.#msg.icalEvent;
		if (ical?.path !== undefined && ical.content === undefined) {
			ical.content = (
				await readAttachment(ical.path, "the calendar event")
			).toString("utf8");
		}
		// `List-*` headers are rendered here, once, rather than in each transport:
		// every transport already forwards `headers`, and only nodemailer has a
		// structured `list` field. `#msg.list` stays as the structured record the
		// `hasListHeader` inspection reads.
		for (const [key, value] of Object.entries(this.#msg.list ?? {})) {
			this.#msg.headers[`List-${titleCaseKey(key)}`] = renderListHeader(value);
		}
		return this.#msg;
	}
}

/**
 * Append one recipient, an array of recipients, or a `(address, name)` pair to
 * a recipient list, formatting each into the `"Name" <address>` display form
 * when a name is present.
 */
function addRecipients(
	list: string[],
	address: string | Recipient[],
	name?: string,
): void {
	if (Array.isArray(address)) {
		for (const entry of address) {
			list.push(
				typeof entry === "string"
					? entry
					: formatAddress(entry.address, entry.name),
			);
		}
		return;
	}
	list.push(formatAddress(address, name));
}
