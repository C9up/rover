import "./augmentations.js";
import type { EmitterLike, MailConfig } from "./Mail.js";
import { Mail } from "./Mail.js";
import type { BayQueueLike } from "./queue/MailJob.js";
import { clearMail, getMail, setMail } from "./services/main.js";

/**
 * Duck-typed slice of the host's IoC container — rover does NOT import
 * `@c9up/ream` so it stays publishable as a standalone package.
 */
interface RoverContainer {
	singleton(token: unknown, factory: () => unknown): void;
	resolve<T = unknown>(token: unknown): Promise<T>;
	/**
	 * Optional reader — present on ream's real container. Asked before resolving
	 * an OPTIONAL peer, so "not installed" is answered by a lookup rather than
	 * inferred from whatever resolving it threw.
	 */
	has?(token: unknown): boolean;
}
interface RoverConfigStore {
	get<T = unknown>(key: string): T | undefined;
}
export interface RoverAppContext {
	container: RoverContainer;
	config: RoverConfigStore;
}

export default class RoverProvider {
	/** The Mail this provider bound, so shutdown only clears its own. */
	#mail: Mail | undefined;

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
		// Namespaced by the package that owns it, the way upstream namespaces
		// `lucid.db`, `auth.manager` and `drive.manager` by theirs. The bare
		// token stays bound beside it: it is what every existing
		// `container.make(...)` asks for, and a token is not worth breaking an
		// application over.
		const mail = (): Promise<Mail> => this.app.container.resolve<Mail>(Mail);
		this.app.container.singleton("rover.mail", mail);
		this.app.container.singleton("mail", mail);
	}

	async boot() {
		// Populate the `@c9up/rover/services/main` singleton with the
		// container-resolved Mail instance so apps can
		// `import mail from '@c9up/rover/services/main'` from anywhere.
		const mail = await this.app.container.resolve<Mail>(Mail);
		this.#mail = mail;
		setMail(mail);
	}

	async shutdown() {
		// Release the module-level singleton, but only while it is still ours: a
		// stopped application left a dead Mail reachable through
		// `services/main`, and with two applications in one process the one
		// shutting down must not clear a binding the other has since installed.
		if (this.#mail !== undefined && getMail() === this.#mail) clearMail();
		this.#mail = undefined;
	}
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
	// ASK whether the token is bound, rather than catching whatever resolving it
	// throws. Catching everything meant a registered binding whose factory
	// failed — a bad queue config, a driver that cannot connect — read exactly
	// like "bay is not installed": rover disabled the feature and said nothing,
	// and mail queued nowhere. Absence is a `has()` answer; a factory that
	// throws is a fault, and faults propagate.
	if (typeof app.container.has === "function" && !app.container.has(token)) {
		return undefined;
	}
	return await app.container.resolve<T>(token);
}
