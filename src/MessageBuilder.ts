import { formatAddress } from "./format.js";
import { RoverError } from "./RoverError.js";
import { renderFile as renderTemplateFile } from "./templating/SimpleTemplate.js";

export interface MailMessage {
	from: string;
	to: string[];
	cc: string[];
	bcc: string[];
	replyTo?: string;
	subject: string;
	html?: string;
	text?: string;
	attachments: MailAttachment[];
	headers: Record<string, string | string[]>;
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
	/** Content-ID for inline (CID) embedding — set via `embedData()`. */
	cid?: string;
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
function contains(list: readonly string[], address?: string): boolean {
	if (address === undefined) return list.length > 0;
	// Addresses are stored formatted (`"Name" <a@b.c>`), so an assertion on the
	// bare address has to match inside the display form too.
	return list.some(
		(entry) => entry === address || entry.includes(`<${address}>`),
	);
}

function expect(passed: boolean, expectation: string, actual: unknown): void {
	if (passed) return;
	throw new RoverError(
		"ASSERTION_FAILED",
		`Expected the message ${expectation}, got ${JSON.stringify(actual)}`,
	);
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

	hasTo(address?: string): boolean {
		return contains(this.#msg.to, address);
	}
	hasCc(address?: string): boolean {
		return contains(this.#msg.cc, address);
	}
	hasBcc(address?: string): boolean {
		return contains(this.#msg.bcc, address);
	}
	hasFrom(address?: string): boolean {
		return contains(this.#msg.from ? [this.#msg.from] : [], address);
	}
	hasReplyTo(address?: string): boolean {
		return contains(this.#msg.replyTo ? [this.#msg.replyTo] : [], address);
	}
	hasSubject(subject?: string): boolean {
		if (subject === undefined) return this.#msg.subject !== "";
		return this.#msg.subject === subject;
	}
	hasAttachment(filename?: string): boolean {
		if (filename === undefined) return this.#msg.attachments.length > 0;
		return this.#msg.attachments.some((a) => a.filename === filename);
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
	assertAttachment(filename: string): void {
		expect(
			this.hasAttachment(filename),
			`an attachment named "${filename}"`,
			this.#msg.attachments.map((a) => a.filename),
		);
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

	attach(
		filename: string,
		content: Buffer | string,
		contentType?: string,
	): this {
		this.#msg.attachments.push({ filename, content, contentType });
		return this;
	}

	/**
	 * Embed inline content referenced by a Content-ID. Use `cid:<cid>` inside the
	 * HTML body to reference it. Content-based (rover is agnostic / no-fs): the
	 * path-based `embed(file, cid)` form from `@adonisjs/mail` is a deliberate
	 * divergence — pass the bytes directly instead.
	 */
	embedData(content: Buffer | string, cid: string, contentType?: string): this {
		this.#msg.attachments.push({ filename: cid, content, contentType, cid });
		return this;
	}

	header(key: string, value: string | string[]): this {
		this.#msg.headers[key] = value;
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

	/**
	 * Finalise the message. `viewsRoot`, when provided by the owning `Mail`,
	 * scopes template resolution to that instance's configured root instead of
	 * the process-wide mutable global — so two `Mail`s with different roots no
	 * longer clobber each other.
	 */
	async build(viewsRoot?: string): Promise<MailMessage> {
		if (this.#pendingView !== null) {
			this.#msg.html = await renderTemplateFile(
				this.#pendingView.path,
				this.#pendingView.data,
				undefined,
				viewsRoot,
			);
			this.#pendingView = null;
		}
		if (this.#pendingTextView !== null) {
			this.#msg.text = await renderTemplateFile(
				this.#pendingTextView.path,
				this.#pendingTextView.data,
				undefined,
				viewsRoot,
			);
			this.#pendingTextView = null;
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
