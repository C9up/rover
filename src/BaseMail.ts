import { type MailMessage, MessageBuilder } from "./MessageBuilder.js";

export type MailAddress = string | { address: string; name: string };

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
	protected readonly message: MessageBuilder = new MessageBuilder();

	from?: MailAddress;
	subject?: string;

	constructor() {
		if (new.target === BaseMail) {
			throw new Error(
				"BaseMail is abstract and cannot be instantiated directly",
			);
		}
	}

	abstract prepare(): void | Promise<void>;

	async build(): Promise<MailMessage> {
		if (this.from !== undefined) {
			this.message.from(formatAddress(this.from));
		}
		if (this.subject !== undefined) {
			this.message.subject(this.subject);
		}
		await this.prepare();
		return this.message.build();
	}
}

function formatAddress(addr: MailAddress): string {
	if (typeof addr === "string") {
		return addr;
	}
	return `"${addr.name}" <${addr.address}>`;
}
