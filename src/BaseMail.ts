import { type MailMessage, MessageBuilder } from "./MessageBuilder.js";

export type MailAddress = string | { address: string; name?: string };

/** The little a mail needs of a mailer to dispatch itself. */
export interface MailSender<R> {
	send(mail: BaseMail): Promise<R>;
	sendLater(mail: BaseMail): Promise<unknown>;
}

/**
 * Abstract base for class-based mail messages (Adonis parity).
 *
 *   class WelcomeMail extends BaseMail {
 *     from = { address: "noreply@acme.com", name: "Acme" };
 *     subject = "Welcome!";
 *     constructor(private user: User) { super(); }
 *     async prepare() {
 *       this.message.to(this.user.email).html(...);
 *     }
 *   }
 *
 *   await mail.send(new WelcomeMail(user));
 */
export abstract class BaseMail {
	/**
	 * The message this mail builds.
	 *
	 * Public, because a test asserts on it from outside —
	 * `mails.assertSent(WelcomeMail, (mail) => mail.message.hasTo(user.email))`
	 * — and a caller may add a recipient before dispatching.
	 */
	readonly message: MessageBuilder = new MessageBuilder();

	from?: MailAddress;
	replyTo?: MailAddress;
	subject?: string;

	/**
	 * Whether {@link build} has already run (AdonisJS `built`).
	 *
	 * Without it, building twice replayed `prepare()` against the SAME
	 * `MessageBuilder`, so every recipient and every attachment was added
	 * again — a mail asserted on with `buildWithContents()` and then sent went
	 * out twice to the same address, with the attachment doubled. Building
	 * twice is ordinary: inspect then send, or retry a send at the app level.
	 */
	built = false;
	/** The message the first build produced, returned by every later call. */
	#builtMessage?: MailMessage;

	constructor() {
		if (new.target === BaseMail) {
			throw new Error(
				"BaseMail is abstract and cannot be instantiated directly",
			);
		}
	}

	abstract prepare(): void | Promise<void>;

	/**
	 * Send this mail through `mailer`.
	 *
	 *   await new WelcomeMail(user).send(mail.use('smtp'))
	 *
	 * The mail object is the dispatchable unit, so it can be handed around and
	 * sent by whoever holds a mailer.
	 */
	async send<R>(mailer: MailSender<R>): Promise<R> {
		return mailer.send(this);
	}

	/** Queue this mail for background delivery (Adonis `sendLater`). */
	async sendLater(mailer: MailSender<unknown>): Promise<void> {
		await mailer.sendLater(this);
	}

	/**
	 * Build the message AND render its templates ahead of time (Adonis
	 * `buildWithContents`), so the contents can be inspected before sending —
	 * which is what an assertion on the rendered html needs.
	 */
	async buildWithContents(viewsRoot?: string): Promise<MailMessage> {
		return this.build(viewsRoot);
	}

	async build(viewsRoot?: string): Promise<MailMessage> {
		if (this.built && this.#builtMessage !== undefined) {
			return this.#builtMessage;
		}
		this.built = true;
		if (this.from !== undefined) {
			applyAddress(this.from, (address, name) =>
				this.message.from(address, name),
			);
		}
		if (this.replyTo !== undefined) {
			applyAddress(this.replyTo, (address, name) =>
				this.message.replyTo(address, name),
			);
		}
		if (this.subject !== undefined) {
			this.message.subject(this.subject);
		}
		await this.prepare();
		// Forward the owning Mail's per-instance viewsRoot so template
		// resolution doesn't depend on the process-wide mutable global.
		this.#builtMessage = await this.message.build(viewsRoot);
		return this.#builtMessage;
	}
}

function applyAddress(
	addr: MailAddress,
	set: (address: string, name?: string) => void,
): void {
	if (typeof addr === "string") {
		set(addr);
		return;
	}
	set(addr.address, addr.name);
}
