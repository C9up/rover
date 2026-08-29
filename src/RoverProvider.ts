import type { EmitterLike, MailConfig } from "./Mail.js";
import { Mail } from "./Mail.js";
import type { BayQueueLike } from "./queue/MailJob.js";
import { setMail } from "./services/main.js";

/**
 * Duck-typed slice of the host's IoC container — rover does NOT import
 * `@c9up/ream` so it stays publishable as a standalone package.
 */
interface RoverContainer {
	singleton(token: unknown, factory: () => unknown): void;
	resolve<T = unknown>(token: unknown): Promise<T>;
}
interface RoverConfigStore {
	get<T = unknown>(key: string): T | undefined;
}
export interface RoverAppContext {
	container: RoverContainer;
	config: RoverConfigStore;
}

export default class RoverProvider {
	constructor(protected app: RoverAppContext) {}

	register() {
		this.app.container.singleton(Mail, async () => {
			const config = this.app.config.get<MailConfig>("mail");
			return new Mail(
				config ?? {
					default: "log",
					from: "noreply@localhost",
					mailers: { log: { transport: "log" } },
				},
				{
					// Optional-peer wiring: if `@c9up/bay` is installed and its
					// `QueueManager` is registered in the container, Mail gets
					// queue support for `sendLater()`. If not, `sendLater()`
					// throws `MAIL_QUEUE_REQUIRED` at call time (by design).
					queue: await tryResolve<BayQueueLike>(this.app, "QueueManager"),
					// Same pattern for the event bus `Emitter` — enables `mail.sent`
					// / `mail.failed` emission when available.
					emitter: await tryResolve<EmitterLike>(this.app, "Emitter"),
				},
			);
		});
		this.app.container.singleton("mail", () => {
			return this.app.container.resolve<Mail>(Mail);
		});
	}

	async boot() {
		// Populate the `@c9up/rover/services/main` singleton with the
		// container-resolved Mail instance so apps can
		// `import mail from '@c9up/rover/services/main'` from anywhere.
		setMail(await this.app.container.resolve<Mail>(Mail));
	}

	async shutdown() {}
}

/**
 * Resolve a token from the container without throwing when it's not
 * registered. Rover never hard-depends on Bay or the event bus — both wire-points
 * are purely opt-in.
 */
async function tryResolve<T>(
	app: RoverAppContext,
	token: string,
): Promise<T | undefined> {
	try {
		return await app.container.resolve<T>(token);
	} catch {
		return undefined;
	}
}
