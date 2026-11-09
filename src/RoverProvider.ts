import "./augmentations.js";
import { field, isRecord } from "./guards.js";
import type { EmitterLike, MailConfig } from "./Mail.js";
import { Mail } from "./Mail.js";
import { MessageBuilder, type TemplateEngine } from "./MessageBuilder.js";
import type { BayQueueLike } from "./queue/MailJob.js";
import { RoverError } from "./RoverError.js";
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
	/** Set by inker's provider when the app renders views with it. */
	usingInker?: boolean;
}

export default class RoverProvider {
	/** The Mail this provider bound, so shutdown only clears its own. */
	#mail: Mail | undefined;
	/** The template engine this provider registered, likewise. */
	#templateEngine: TemplateEngine | undefined;

	constructor(protected app: RoverAppContext) {}

	register() {
		this.app.container.singleton(Mail, async () => {
			const config = this.app.config.get<MailConfig>("mail");
			// No silent fallback: a log-only mailer would boot healthy, deliver
			// nothing and print every message, reset links included.
			if (config === undefined || config === null) {
				throw new RoverError(
					"E_MAIL_CONFIG_MISSING",
					'Invalid "config/mail.ts" file: no `mail` config is registered.',
					{
						hint: "Create config/mail.ts with defineConfig(), or run `ream configure @c9up/rover`.",
					},
				);
			}
			return new Mail(config, {
				// Optional-peer wiring: if `@c9up/bay` is installed and its
				// `QueueManager` is registered in the container, Mail gets
				// queue support for `sendLater()`. If not, `sendLater()`
				// throws `MAIL_QUEUE_REQUIRED` at call time (by design).
				queue: await tryResolve<BayQueueLike>(this.app, "QueueManager"),
				// Same pattern for the event bus `Emitter` — enables `mail.sent`
				// / `mail.failed` emission when available.
				emitter: await tryResolve<EmitterLike>(this.app, "Emitter"),
			});
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
		// Mail views render with the app's view engine when it has one, as the
		// upstream provider registers Edge for its Message class.
		if (this.app.usingInker === true) {
			this.#templateEngine = await inkerTemplateEngine();
			MessageBuilder.templateEngine = this.#templateEngine;
		}
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
		if (
			this.#templateEngine !== undefined &&
			MessageBuilder.templateEngine === this.#templateEngine
		) {
			MessageBuilder.templateEngine = undefined;
		}
		this.#templateEngine = undefined;
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

/** An object with a `share(state)` method: inker's module singleton. */
function isSharingEngine(
	value: unknown,
): value is { share(state: Record<string, unknown>): unknown } {
	return isRecord(value) && typeof value.share === "function";
}

function unusableInker(reason: string): RoverError {
	return new RoverError(
		"E_MAIL_TEMPLATE_ENGINE",
		`The app uses inker, but rover cannot render mail views with it: ${reason}`,
		{
			hint: "Install a @c9up/inker version whose default export has share(state).render(template, data).",
		},
	);
}

/**
 * Mail views through inker: `inker.share(sharedState).render(template, data)`,
 * the same call the upstream provider makes on Edge. Fails loudly when the
 * module is not what that needs, rather than quietly rendering with rover's
 * built-in engine, which reads a different template language.
 */
async function inkerTemplateEngine(): Promise<TemplateEngine> {
	// A computed specifier: inker is an optional peer, so a bundler must not
	// try to resolve it for apps that do not install it.
	const specifier = "@c9up/inker";
	let loaded: unknown;
	try {
		loaded = await import(/* @vite-ignore */ specifier);
	} catch (cause) {
		throw unusableInker(
			`importing @c9up/inker failed (${cause instanceof Error ? cause.message : String(cause)})`,
		);
	}
	const inker = field(loaded, "default");
	if (!isSharingEngine(inker)) {
		throw unusableInker("its default export has no share() method");
	}
	return {
		async render(template, sharedState, data) {
			const renderer = inker.share(sharedState);
			const render = field(renderer, "render");
			if (typeof render !== "function") {
				throw unusableInker("share() returned no render() method");
			}
			const html: unknown = await Reflect.apply(render, renderer, [
				template,
				data,
			]);
			if (typeof html !== "string") {
				throw unusableInker(`render('${template}') did not produce a string`);
			}
			return html;
		},
	};
}
