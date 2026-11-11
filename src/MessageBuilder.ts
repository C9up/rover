import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assertAddress,
	assertHeaderName,
	assertHeaderValue,
	assertRecipient,
	formatRecipient,
	isAddrSpec,
	type Recipient,
	recipientAddress,
	recipientName,
	toRecipient,
} from "./format.js";
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
	/**
	 * Addresses are kept structured, as AdonisJS keeps them: a bare address,
	 * or `{ address, name }`. Never a pre-formatted `"Name" <addr>` string,
	 * which the next layer would re-parse as an address list.
	 */
	from: Recipient;
	to: Recipient[];
	cc: Recipient[];
	bcc: Recipient[];
	replyTo?: Recipient[];
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
 * The calendar handed to an `icalEvent(callback)`.
 *
 * Structural, and deliberately not `ICalCalendar`: `ical-generator` is an
 * OPTIONAL peer, so importing its type here would make every consumer install
 * it to typecheck. A caller who has the package gets the real object at
 * runtime and can annotate their own callback with the real type.
 */
export interface CalendarBuilder {
	createEvent(data: Record<string, unknown>): unknown;
	toString(): string;
}

/** Builds the invitation in place (AdonisJS `icalEvent(callback)`). */
export type CalendarEventCallback = (calendar: CalendarBuilder) => void;

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
	/**
	 * How a string `content` is encoded (nodemailer `encoding`): `base64`,
	 * `hex`, `latin1`... The bytes sent are the decoded ones.
	 */
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
 * A recipient in object form, as the builder accepts it. `name` is optional
 * here; an empty or missing name is stored as the bare address.
 */
export interface RecipientObject {
	address: string;
	name?: string;
}

export type { Recipient };

/** What `to([...])` / `cc([...])` / `bcc([...])` accept. */
export type RecipientInput = string | RecipientObject;

/**
 * Whether `list` holds `address`, or anything at all when it is omitted. With
 * a name, both halves must match (AdonisJS `hasRecipient`).
 */
function contains(
	list: readonly Recipient[],
	address?: string,
	name?: string,
): boolean {
	if (address === undefined) return list.length > 0;
	return list.some(
		(entry) =>
			recipientAddress(entry) === address &&
			(name === undefined || recipientName(entry) === name),
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
			"E_ICAL_HREF_UNSUPPORTED",
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

/**
 * Check an envelope: every entry one addr-spec. nodemailer parses envelope
 * strings as address lists, so `"a@x, b@y"` would add an RCPT TO nobody
 * asked for.
 */
/** Every line ending as CRLF: a lone CR or LF becomes CRLF. */
function canonicalLineEndings(text: string): string {
	return text.replace(/\r\n|\r|\n/g, "\r\n");
}

/**
 * The message with every textual body in canonical CRLF form.
 *
 * nodemailer sends a short ASCII body as 7bit and normalises LF, but leaves a
 * lone CR as it is. `<CR>.<CR><LF>` then reaches the DATA stream, and a
 * receiver that reads a bare CR as a line end takes it for the end of the
 * message: whatever follows is parsed as new SMTP commands (SMTP smuggling,
 * CVE-2023-51764). RFC 5321 §2.3.8 forbids a bare CR or LF in the stream.
 * Stricter than the upstream default, deliberately.
 */
export function withCanonicalLineEndings(message: MailMessage): MailMessage {
	const fix = (text: string | undefined) =>
		text === undefined ? undefined : canonicalLineEndings(text);
	const ical = message.icalEvent;
	return {
		...message,
		text: fix(message.text),
		html: fix(message.html),
		watchHtml: fix(message.watchHtml),
		icalEvent:
			ical?.content === undefined
				? ical
				: { ...ical, content: canonicalLineEndings(ical.content) },
	};
}

/**
 * Check every header of a message that may not have come through the builder
 * (a queue payload, a hand-built message).
 */
export function assertHeaders(headers: unknown): void {
	if (typeof headers !== "object" || headers === null) {
		throw new RoverError(
			"E_MAIL_INVALID_MESSAGE",
			"Mail message `headers` must be an object",
		);
	}
	for (const [name, value] of Object.entries(headers)) {
		assertHeaderName(name);
		if (Array.isArray(value)) {
			for (const entry of value) assertHeaderValue(entry, name);
		} else if (typeof value === "object" && value !== null) {
			assertHeaderValue(Reflect.get(value, "value"), name);
		} else {
			assertHeaderValue(value, name);
		}
	}
}

export function assertEnvelope(envelope: unknown): MailEnvelope {
	if (typeof envelope !== "object" || envelope === null) {
		throw new RoverError(
			"E_MAIL_INVALID_MESSAGE",
			"The envelope must be an object",
		);
	}
	const out: MailEnvelope = {};
	const from: unknown = Reflect.get(envelope, "from");
	if (from !== undefined) out.from = assertAddress(from, "envelope sender");
	for (const field of ["to", "cc", "bcc"] as const) {
		const value: unknown = Reflect.get(envelope, field);
		if (value === undefined) continue;
		out[field] = Array.isArray(value)
			? value.map((entry) => assertAddress(entry, `envelope ${field}`))
			: assertAddress(value, `envelope ${field}`);
	}
	return out;
}

/**
 * Refuse a message whose envelope a provider API cannot express, rather than
 * deliver it to the header recipients: a caller who set an envelope to
 * restrict delivery must not have the message reach the visible addresses.
 */
export function assertNoEnvelope(message: MailMessage, provider: string): void {
	if (message.envelope === undefined) return;
	throw new RoverError(
		"E_MAIL_FIELD_UNSUPPORTED",
		`The ${provider} transport cannot set the SMTP envelope.`,
		{
			hint: "Send this message through an SMTP mailer, or drop envelope().",
			context: { provider, field: "envelope" },
		},
	);
}

/** Read a file declared by `attach()` / `embed()` / `icalEventFromFile()`. */
async function readAttachment(path: string, label: string): Promise<Buffer> {
	try {
		return await readFile(path);
	} catch (err) {
		throw new RoverError(
			"E_ATTACHMENT_UNREADABLE",
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
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("-");
}

/** Every entry of a `List-*` value, whatever nesting form it was written in. */
function listEntries(
	value: ListHeader | ListHeader[] | ListHeader[][],
): Array<{ url: string; comment?: string }> {
	if (typeof value === "string") return [{ url: value }];
	if (Array.isArray(value)) return value.flatMap((entry) => listEntries(entry));
	return [value];
}

function invalidList(message: string): RoverError {
	return new RoverError("E_INVALID_LIST_HEADER", message, {
		hint: "Give one https:, http:, mailto: or ftp: URL (or a bare address) per entry, without spaces or angle brackets.",
	});
}

/** No whitespace, control character or angle bracket. */
function isBracketSafe(url: string): boolean {
	for (const char of url) {
		const code = char.codePointAt(0) ?? 0;
		if (code <= 0x20 || code === 0x7f || char === "<" || char === ">") {
			return false;
		}
		if (/\s/.test(char)) return false;
	}
	return true;
}

/** Schemes nodemailer passes through as they are (RFC 2369 §2). */
const LIST_URL_SCHEME = /^(https?|mailto|ftp):/;

/**
 * Check one `List-*` entry. The URL goes between angle brackets on the wire,
 * so a `>` or a space in it would close the bracket and let a second target
 * follow — a second one-click unsubscribe URL a mailbox provider may POST to.
 */
function assertListEntry(
	key: string,
	entry: { url: string; comment?: string },
) {
	const { url, comment } = entry;
	if (typeof url !== "string" || url === "" || !isBracketSafe(url)) {
		throw invalidList(
			`List-${key} URL ${JSON.stringify(url)} is not a single URL.`,
		);
	}
	if (key.toLowerCase() === "id") {
		if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(url)) {
			throw invalidList(
				`List-Id ${JSON.stringify(url)} is not a list identifier.`,
			);
		}
	} else if (!isAddrSpec(url)) {
		if (!LIST_URL_SCHEME.test(url) || !URL.canParse(url)) {
			throw invalidList(
				`List-${key} URL ${JSON.stringify(url)} is not an https:, http:, mailto: or ftp: URL.`,
			);
		}
	}
	if (
		comment !== undefined &&
		(typeof comment !== "string" || /[\r\n\0]/.test(comment))
	) {
		throw invalidList(
			`List-${key} comment must be a string without line breaks.`,
		);
	}
}

/** RFC 2047 `B` encoded-words, each at most 75 characters. */
function encodeWords(text: string): string {
	const words: string[] = [];
	let chunk = "";
	for (const char of text) {
		if (Buffer.byteLength(chunk + char) > 45) {
			words.push(chunk);
			chunk = "";
		}
		chunk += char;
	}
	if (chunk !== "") words.push(chunk);
	return words
		.map((word) => `=?UTF-8?B?${Buffer.from(word).toString("base64")}?=`)
		.join(" ");
}

/** Whether `text` can travel in a header as is: printable ASCII and tab. */
function isPlainHeaderText(text: string): boolean {
	return /^[\t\x20-\x7e]*$/.test(text);
}

/** One `List-*` entry as nodemailer renders it (mail-message `_getListHeaders`). */
function renderListEntry(
	key: string,
	{ url, comment }: { url: string; comment?: string },
): string {
	const bracketed = LIST_URL_SCHEME.test(url)
		? `<${url}>`
		: isAddrSpec(url)
			? `<mailto:${url}>`
			: `<${url}>`;
	if (comment === undefined || comment === "") return bracketed;
	const plain = isPlainHeaderText(comment);
	if (key.toLowerCase() === "id") {
		const phrase = plain
			? `"${comment.replace(/[\\"]/g, "\\$&")}"`
			: encodeWords(comment);
		return `${phrase} ${bracketed.replace(/^<[^:]+:\/{0,2}/, "<")}`;
	}
	// `(`, `)` and `\` go out as quoted-pairs, or a `)` would close the
	// comment early and leave the rest of it read as more URLs.
	const escaped = plain
		? comment.replace(/[()\\]/g, "\\$&")
		: encodeWords(comment);
	return `${bracketed} (${escaped})`;
}

/**
 * The `List-*` headers of a message, rendered the way nodemailer renders them,
 * for the transports that take a plain header map. Several values of one key
 * are joined with `, ` into one header, as a JSON header map cannot repeat a
 * key. The SMTP transport hands the structured form to nodemailer instead.
 */
export function listHeaders(message: MailMessage): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(message.list ?? {})) {
		out[`List-${titleCaseKey(key)}`] = listEntries(value)
			.map((entry) => renderListEntry(key, entry))
			.join(", ");
	}
	return out;
}

/** A message id in its header form, `<id>`. */
function angled(id: string): string {
	return `<${id.trim().replace(/^<|>$/g, "")}>`;
}

/** The priority headers nodemailer writes (mail-message `setPriorityHeaders`). */
const PRIORITY_HEADERS: Record<"high" | "low", Record<string, string>> = {
	high: {
		"X-Priority": "1 (Highest)",
		"X-MSMail-Priority": "High",
		Importance: "High",
	},
	low: {
		"X-Priority": "5 (Lowest)",
		"X-MSMail-Priority": "Low",
		Importance: "Low",
	},
};

/**
 * Every header a provider JSON API has to be handed explicitly: the
 * message's own, `List-*`, the threading ids (Message-ID, In-Reply-To,
 * References) and the priority, which nodemailer would otherwise have
 * written. Without them replies sent through these mailers are not threaded.
 */
export function headersForApi(
	message: MailMessage,
): Record<string, string | string[] | PreparedHeader> {
	const out = headersWithList(message);
	if (message.messageId) out["Message-ID"] = angled(message.messageId);
	if (message.inReplyTo) out["In-Reply-To"] = angled(message.inReplyTo);
	if (message.references?.length) {
		out.References = message.references.map(angled).join(" ");
	}
	if (message.priority === "high" || message.priority === "low") {
		Object.assign(out, PRIORITY_HEADERS[message.priority]);
	}
	return out;
}

/**
 * An attachment's bytes, whichever form they were given in. A string is
 * decoded by the attachment's `encoding`, normalised the way nodemailer
 * normalises it (`Base-64` is `base64`), so a JSON API gets the same bytes the
 * MIME transports put on the wire.
 */
export function attachmentBytes(attachment: MailAttachment): Buffer {
	const { content } = attachment;
	if (typeof content !== "string") return Buffer.from(content);
	const encoding = (attachment.encoding ?? "utf8")
		.toLowerCase()
		.replace(/[-_\s]/g, "");
	if (encoding === "usascii" || encoding === "ascii") {
		return Buffer.from(content, "utf8");
	}
	if (!Buffer.isEncoding(encoding)) {
		throw new RoverError(
			"E_MAIL_INVALID_MESSAGE",
			`Attachment "${attachment.filename}" has an unknown encoding ${JSON.stringify(attachment.encoding)}`,
			{
				hint: "Use base64, hex, latin1 or utf8, or pass the bytes as a Buffer.",
			},
		);
	}
	return Buffer.from(content, encoding);
}

/** What a provider JSON API can say about one attachment part. */
export interface ApiAttachmentSupport {
	/** A content id, so `<img src="cid:...">` resolves to the part. */
	contentId: boolean;
	/** An explicit disposition, so a part without a cid can be inline. */
	disposition: boolean;
}

/**
 * Refuse a message carrying something a provider JSON API has no field for,
 * rather than send it without: a watch body, per-part headers, an inline
 * image the API can only send as a plain attachment. The raw-MIME transports
 * (SMTP, Mailgun, SES, SparkPost) carry all of them.
 */
export function assertApiCarries(
	message: MailMessage,
	provider: string,
	support: ApiAttachmentSupport,
): void {
	const unsupported = (field: string, hint: string) =>
		new RoverError(
			"E_MAIL_FIELD_UNSUPPORTED",
			`The ${provider} API cannot carry ${field}.`,
			{ hint, context: { provider, field } },
		);
	const mimeHint =
		"Send this message through an SMTP, Mailgun, SES or SparkPost mailer, which send the full MIME message.";
	if (message.watchHtml) {
		throw unsupported("watchHtml", `${mimeHint} Or drop watch().`);
	}
	for (const att of message.attachments) {
		if (att.headers !== undefined && Object.keys(att.headers).length > 0) {
			throw unsupported(
				"attachments[].headers",
				`${mimeHint} Or drop the part headers.`,
			);
		}
		if (att.cid !== undefined && !support.contentId) {
			throw unsupported(
				"attachments[].cid",
				`${mimeHint} Or attach the image with attachData() and link to it.`,
			);
		}
		if (
			att.contentDisposition === "inline" &&
			att.cid === undefined &&
			!support.disposition
		) {
			throw unsupported(
				"attachments[].contentDisposition",
				`${mimeHint} Or give the part a cid with embedData().`,
			);
		}
	}
}

/**
 * A message's own headers plus its rendered `List-*` headers: what a
 * transport without nodemailer's `list` field sends.
 */
export function headersWithList(
	message: MailMessage,
): Record<string, string | string[] | PreparedHeader> {
	return { ...message.headers, ...listHeaders(message) };
}

function expect(passed: boolean, expectation: string, actual: unknown): void {
	if (passed) return;
	throw new RoverError(
		"E_ASSERTION_FAILED",
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
	watch?: { template: string; data: Record<string, unknown> };
}

/**
 * Renders a view for `htmlView()` / `textView()` / `watchView()` (AdonisJS
 * `TemplateEngineContract`). `sharedState` holds the mailer's `globals` and,
 * for the html and watch bodies, the `embedImage` / `embedImageData` helpers.
 */
export interface TemplateEngine {
	render(
		templatePath: string,
		sharedState: Record<string, unknown>,
		data: Record<string, unknown>,
	): string | Promise<string>;
}

/** Options an embedded image takes besides its source. */
export type EmbedImageOptions = Omit<AttachmentOptions, "contentDisposition">;

export class MessageBuilder {
	/**
	 * The engine views render through (AdonisJS `Message.templateEngine`). An
	 * integration registers its own — an app's view engine — and messages then
	 * render with it. Unset, rover's built-in `{{ }}` engine renders `.html`
	 * files under `viewsRoot`.
	 */
	static templateEngine: TemplateEngine | undefined;

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
	/** An `icalEvent(callback)` waiting for `build()` to run it. */
	#pendingCalendar: {
		build: CalendarEventCallback;
		options?: CalendarEventOptions;
	} | null = null;
	/**
	 * The templates {@link build} actually rendered. Recorded because `build()`
	 * clears the pending views once they are rendered, and the lifecycle events
	 * carry them (AdonisJS `views`, the third field of every mail event) — an
	 * app logging a send wants to know which template produced it.
	 */
	#renderedViews: MessageBodyTemplates = {};
	#pendingWatchView: { path: string; data: Record<string, unknown> } | null =
		null;
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
		this.#msg.envelope = assertEnvelope(envelope);
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
		return contains(this.#msg.replyTo ?? [], address, name);
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
		expect(
			this.hasTo(address),
			`to include "${address}"`,
			this.#msg.to.map(formatRecipient),
		);
	}
	assertFrom(address: string): void {
		expect(
			this.hasFrom(address),
			`from to be "${address}"`,
			this.#msg.from ? formatRecipient(this.#msg.from) : "",
		);
	}
	assertCc(address: string): void {
		expect(
			this.hasCc(address),
			`cc to include "${address}"`,
			this.#msg.cc.map(formatRecipient),
		);
	}
	assertBcc(address: string): void {
		expect(
			this.hasBcc(address),
			`bcc to include "${address}"`,
			this.#msg.bcc.map(formatRecipient),
		);
	}
	assertReplyTo(address: string): void {
		expect(
			this.hasReplyTo(address),
			`replyTo to include "${address}"`,
			(this.#msg.replyTo ?? []).map(formatRecipient),
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
			to: this.#msg.to.map(formatRecipient),
			cc: this.#msg.cc.map(formatRecipient),
			bcc: this.#msg.bcc.map(formatRecipient),
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

	/**
	 * The Apple Watch body contains `substring` (AdonisJS
	 * `assertWatchIncludes`).
	 *
	 * Takes a RegExp as well as a string, as upstream does — a rendered body
	 * rarely matches a fixed substring exactly.
	 */
	assertWatchIncludes(substring: string | RegExp): void {
		const body = this.#msg.watchHtml ?? "";
		const hit =
			typeof substring === "string"
				? body.includes(substring)
				: substring.test(body);
		expect(hit, `watch body to include "${String(substring)}"`, body);
	}

	from(address: string, name?: string): this {
		this.#msg.from = toRecipient(address, name);
		return this;
	}

	to(address: string, name?: string): this;
	to(addresses: RecipientInput[]): this;
	to(address: string | RecipientInput[], name?: string): this {
		addRecipients(this.#msg.to, address, name);
		return this;
	}

	cc(address: string, name?: string): this;
	cc(addresses: RecipientInput[]): this;
	cc(address: string | RecipientInput[], name?: string): this {
		addRecipients(this.#msg.cc, address, name);
		return this;
	}

	bcc(address: string, name?: string): this;
	bcc(addresses: RecipientInput[]): this;
	bcc(address: string | RecipientInput[], name?: string): this {
		addRecipients(this.#msg.bcc, address, name);
		return this;
	}

	/**
	 * Add a Reply-To address (AdonisJS `replyTo`). Each call adds one, as
	 * upstream's does: a second call no longer drops the first.
	 */
	replyTo(address: string, name?: string): this {
		this.#msg.replyTo ??= [];
		this.#msg.replyTo.push(toRecipient(address, name));
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

	/**
	 * Render a template as the Apple Watch body (AdonisJS `watchView`).
	 *
	 * The counterpart of {@link htmlView} and {@link textView}: the render
	 * happens lazily at `build()` time so the fluent chain stays synchronous.
	 */
	watchView(viewPath: string, data?: Record<string, unknown>): this {
		this.#pendingWatchView = { path: viewPath, data: data ?? {} };
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
		this.#msg.messageId = assertHeaderValue(messageId, "Message-ID");
		return this;
	}

	/** Set the `In-Reply-To` header for threading replies. */
	inReplyTo(messageId: string): this {
		this.#msg.inReplyTo = assertHeaderValue(messageId, "In-Reply-To");
		return this;
	}

	/** Set the `References` header (thread message ids). */
	references(messageIds: string[]): this {
		this.#msg.references = messageIds.map((id) =>
			assertHeaderValue(id, "References"),
		);
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
		assertHeaderName(key);
		if (Array.isArray(value)) {
			for (const entry of value) assertHeaderValue(entry, key);
			this.#msg.headers[key] = value.slice();
		} else {
			this.#msg.headers[key] = assertHeaderValue(value, key);
		}
		return this;
	}

	/**
	 * A header nodemailer passes through untouched (AdonisJS `preparedHeader`).
	 *
	 * Use it when the value IS what must appear on the wire and re-encoding
	 * would corrupt it — a signature, an already-encoded message id.
	 */
	preparedHeader(key: string, value: string): this {
		assertHeaderName(key);
		this.#msg.headers[key] = {
			prepared: true,
			value: assertHeaderValue(value, key),
		};
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
		assertHeaderName(`List-${key}`);
		for (const entry of listEntries(value)) assertListEntry(key, entry);
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
				// RFC 8058 §3.1: the one-click target MUST be HTTPS.
				if (!URL.canParse(url) || new URL(url).protocol !== "https:") {
					throw new RoverError(
						"E_INVALID_LIST_HEADER",
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
	 * Attach a calendar invitation (AdonisJS `icalEvent`).
	 *
	 * Takes either the ICS text or a `(calendar) => void` builder, as upstream
	 * does. The builder runs at {@link build} time against an `ical-generator`
	 * calendar; that package is an OPTIONAL peer, so passing the text needs
	 * nothing installed. {@link icalEventFromFile} and {@link icalEventFromUrl}
	 * are the other two upstream forms.
	 */
	icalEvent(
		contents: string | CalendarEventCallback,
		options?: CalendarEventOptions,
	): this {
		if (typeof contents === "function") {
			// Resolved at `build()`, not here: `ical-generator` is an optional
			// peer that has to be imported dynamically, and the fluent chain
			// stays synchronous — the same deferral `icalEventFromFile` uses to
			// read its file.
			this.#pendingCalendar = { build: contents, options };
			this.#msg.icalEvent = undefined;
			return this;
		}
		this.#pendingCalendar = null;
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

	/** AdonisJS' name for {@link views}. */
	get contentViews(): MessageBodyTemplates {
		return this.views;
	}

	/**
	 * The message as a plain object (AdonisJS `nodeMailerMessage`).
	 *
	 * A live reference, as upstream's is — this is the object the transports
	 * read, not a snapshot. {@link build} is what finalises it.
	 */
	get nodeMailerMessage(): MailMessage {
		return this.#msg;
	}

	/**
	 * Finalise the message. `viewsRoot`, when provided by the owning `Mail`,
	 * scopes template resolution to that instance's configured root instead of
	 * the process-wide mutable global — so two `Mail`s with different roots no
	 * longer clobber each other.
	 */
	/**
	 * Render one view through the registered engine, or the built-in one.
	 * `withImages` hands the html and watch templates the helpers that embed
	 * an image and return its `cid:` URL.
	 */
	async #render(
		view: { path: string; data: Record<string, unknown> },
		viewsRoot: string | undefined,
		globals: Record<string, unknown>,
		withImages: boolean,
	): Promise<string> {
		const engine = MessageBuilder.templateEngine;
		if (engine === undefined) {
			return renderTemplateFile(view.path, view.data, undefined, viewsRoot);
		}
		const shared: Record<string, unknown> = { ...globals };
		if (withImages) {
			shared.embedImage = (filePath: string, options?: EmbedImageOptions) => {
				const cid = randomUUID();
				this.embed(filePath, cid, options);
				return `cid:${cid}`;
			};
			shared.embedImageData = (
				content: Buffer | string,
				options?: EmbedImageOptions,
			) => {
				const cid = randomUUID();
				this.embedData(content, cid, options);
				return `cid:${cid}`;
			};
		}
		return engine.render(view.path, shared, view.data);
	}

	async build(
		viewsRoot?: string,
		globals: Record<string, unknown> = {},
	): Promise<MailMessage> {
		if (this.#pendingCalendar !== null) {
			this.#msg.icalEvent = {
				...this.#pendingCalendar.options,
				content: await renderCalendar(this.#pendingCalendar.build),
			};
			this.#pendingCalendar = null;
		}
		if (this.#pendingView !== null) {
			this.#renderedViews.html = {
				template: this.#pendingView.path,
				data: this.#pendingView.data,
			};
			this.#msg.html = await this.#render(
				this.#pendingView,
				viewsRoot,
				globals,
				true,
			);
			this.#pendingView = null;
		}
		if (this.#pendingWatchView !== null) {
			this.#renderedViews.watch = {
				template: this.#pendingWatchView.path,
				data: this.#pendingWatchView.data,
			};
			this.#msg.watchHtml = await this.#render(
				this.#pendingWatchView,
				viewsRoot,
				globals,
				true,
			);
			this.#pendingWatchView = null;
		}
		if (this.#pendingTextView !== null) {
			this.#renderedViews.text = {
				template: this.#pendingTextView.path,
				data: this.#pendingTextView.data,
			};
			this.#msg.text = await this.#render(
				this.#pendingTextView,
				viewsRoot,
				globals,
				false,
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
		// `List-*` stay structured in `list`: SMTP hands them to nodemailer,
		// which escapes and folds them, and the other transports render them
		// with `listHeaders()`. Rendering them into `headers` here as well
		// would emit each one twice over SMTP.
		return this.#msg;
	}
}

/**
 * Append one recipient, an array of recipients, or a `(address, name)` pair to
 * a recipient list. Every form goes through the same validation: a string
 * entry of an array is checked exactly like `to(string)`.
 */
function addRecipients(
	list: Recipient[],
	address: string | RecipientInput[],
	name?: string,
): void {
	if (Array.isArray(address)) {
		// Validate the whole array before adding any of it.
		const entries = address.map((entry) => assertRecipient(entry));
		list.push(...entries);
		return;
	}
	list.push(toRecipient(address, name));
}

/**
 * Run an `icalEvent(callback)` against a real `ical-generator` calendar.
 *
 * The package is an optional peer: an app that never builds an invitation
 * should not carry an iCalendar library. When one IS built without it
 * installed, say exactly that — the alternative is a `Cannot find module`
 * thrown from inside a mail send, which reads as a mail bug.
 */
async function renderCalendar(build: CalendarEventCallback): Promise<string> {
	let factory: unknown;
	try {
		const mod: { default?: unknown } = await import("ical-generator");
		factory = mod.default;
	} catch (cause) {
		throw new RoverError(
			"E_MAIL_PROVIDER_CONFIG",
			"icalEvent(callback) needs the `ical-generator` package, which is not installed.",
			{
				hint: "Install ical-generator, or pass the ICS yourself with icalEvent(contents).",
				context: {
					reason: cause instanceof Error ? cause.message : String(cause),
				},
			},
		);
	}
	if (typeof factory !== "function") {
		throw new RoverError(
			"E_MAIL_PROVIDER_CONFIG",
			"`ical-generator` did not export a calendar factory.",
		);
	}
	const calendar: unknown = factory();
	if (!isCalendarBuilder(calendar)) {
		throw new RoverError(
			"E_MAIL_PROVIDER_CONFIG",
			"`ical-generator` returned an object without createEvent()/toString().",
		);
	}
	build(calendar);
	return calendar.toString();
}

function isCalendarBuilder(value: unknown): value is CalendarBuilder {
	return (
		typeof value === "object" &&
		value !== null &&
		"createEvent" in value &&
		typeof value.createEvent === "function" &&
		typeof value.toString === "function"
	);
}
