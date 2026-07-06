import { formatAddress } from "./format.js";
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
