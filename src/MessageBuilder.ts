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
	headers: Record<string, string>;
}

export interface MailAttachment {
	filename: string;
	content: Buffer | string;
	contentType?: string;
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

	from(address: string): this {
		this.#msg.from = address;
		return this;
	}
	to(address: string): this {
		this.#msg.to.push(address);
		return this;
	}
	cc(address: string): this {
		this.#msg.cc.push(address);
		return this;
	}
	bcc(address: string): this {
		this.#msg.bcc.push(address);
		return this;
	}
	replyTo(address: string): this {
		this.#msg.replyTo = address;
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

	attach(
		filename: string,
		content: Buffer | string,
		contentType?: string,
	): this {
		this.#msg.attachments.push({ filename, content, contentType });
		return this;
	}

	header(key: string, value: string): this {
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
