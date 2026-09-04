import type { PluginApi } from "@c9up/helix";
import { BaseMail } from "../BaseMail.js";
import type { MailMessage, MailSendOutcome, MailTransport } from "../Mail.js";

export interface FakeMailPredicate {
	from?: string;
	to?: string;
	cc?: string;
	bcc?: string;
	replyTo?: string;
	subject?: string;
	containing?: string;
}

export type FakeMailPredicateArg =
	| FakeMailPredicate
	| ((m: MailMessage) => boolean);

/**
 * Constructor of a `BaseMail` subclass — the `new (...args: never[]) => T`
 * form keeps `instanceof` sound without an `any` in the signature.
 */
export type MailConstructor<T extends BaseMail = BaseMail> = new (
	...args: never[]
) => T;

interface Capture {
	message: MailMessage;
	mail?: BaseMail;
}

/**
 * In-memory capture for tests — records every `send` (`trackSent`) and
 * `sendLater` (`trackQueued`) routed through a faked `Mail`, and exposes
 * Adonis/Laravel-style assertions over both message content (predicate form)
 * and the originating `BaseMail` class (constructor form).
 *
 * Not re-exported from the main barrel; reach via `@c9up/rover/testing`.
 */
export class FakeMail implements MailTransport {
	#sent: Capture[] = [];
	#queued: Capture[] = [];

	/** MailTransport contract — direct `send()` capture (backward compatible). */
	async send(message: MailMessage): Promise<MailSendOutcome> {
		this.trackSent(message);
		return undefined;
	}

	/** Record a synchronously-sent message (and its source `BaseMail`, if any). */
	trackSent(message: MailMessage, mail?: BaseMail): void {
		this.#sent.push({ message, mail });
	}

	/** Record a queued message (and its source `BaseMail`, if any). */
	trackQueued(message: MailMessage, mail?: BaseMail): void {
		this.#queued.push({ message, mail });
	}

	/**
	 * Return a defensive snapshot of sent messages. Each message is cloned
	 * (shallow-per-field with array copies) so test-side mutations can't bleed
	 * back into the internal capture store — avoids cross-test contamination.
	 */
	getSent(): MailMessage[] {
		return this.#sent.map((e) => cloneMessage(e.message));
	}

	/** Return a defensive snapshot of queued messages. */
	getQueued(): MailMessage[] {
		return this.#queued.map((e) => cloneMessage(e.message));
	}

	reset(): void {
		this.#sent = [];
		this.#queued = [];
	}

	assertSent(predicate: FakeMailPredicateArg): void;
	assertSent<T extends BaseMail>(
		mailConstructor: MailConstructor<T>,
		findFn?: (mail: T) => boolean,
	): void;
	assertSent(
		arg: FakeMailPredicateArg | MailConstructor<BaseMail>,
		findFn?: (mail: BaseMail) => boolean,
	): void {
		this.#assertPresence("assertSent", "sent", this.#sent, arg, findFn, true);
	}

	assertNotSent(predicate: FakeMailPredicateArg): void;
	assertNotSent<T extends BaseMail>(
		mailConstructor: MailConstructor<T>,
		findFn?: (mail: T) => boolean,
	): void;
	assertNotSent(
		arg: FakeMailPredicateArg | MailConstructor<BaseMail>,
		findFn?: (mail: BaseMail) => boolean,
	): void {
		this.#assertPresence(
			"assertNotSent",
			"sent",
			this.#sent,
			arg,
			findFn,
			false,
		);
	}

	assertQueued(predicate: FakeMailPredicateArg): void;
	assertQueued<T extends BaseMail>(
		mailConstructor: MailConstructor<T>,
		findFn?: (mail: T) => boolean,
	): void;
	assertQueued(
		arg: FakeMailPredicateArg | MailConstructor<BaseMail>,
		findFn?: (mail: BaseMail) => boolean,
	): void {
		this.#assertPresence(
			"assertQueued",
			"queued",
			this.#queued,
			arg,
			findFn,
			true,
		);
	}

	assertNotQueued(predicate: FakeMailPredicateArg): void;
	assertNotQueued<T extends BaseMail>(
		mailConstructor: MailConstructor<T>,
		findFn?: (mail: T) => boolean,
	): void;
	assertNotQueued(
		arg: FakeMailPredicateArg | MailConstructor<BaseMail>,
		findFn?: (mail: BaseMail) => boolean,
	): void {
		this.#assertPresence(
			"assertNotQueued",
			"queued",
			this.#queued,
			arg,
			findFn,
			false,
		);
	}

	assertSentCount(count: number): void;
	assertSentCount(
		mailConstructor: MailConstructor<BaseMail>,
		count: number,
	): void;
	assertSentCount(
		arg: number | MailConstructor<BaseMail>,
		count?: number,
	): void {
		this.#assertCount("assertSentCount", this.#sent, arg, count);
	}

	assertQueuedCount(count: number): void;
	assertQueuedCount(
		mailConstructor: MailConstructor<BaseMail>,
		count: number,
	): void;
	assertQueuedCount(
		arg: number | MailConstructor<BaseMail>,
		count?: number,
	): void {
		this.#assertCount("assertQueuedCount", this.#queued, arg, count);
	}

	assertNoneSent(): void {
		if (this.#sent.length !== 0) {
			throw new Error(
				`mail.assertNoneSent() failed — expected zero sent messages, found ${this.#sent.length}.\n${describeCaptured(this.#sent)}`,
			);
		}
	}

	assertNoneQueued(): void {
		if (this.#queued.length !== 0) {
			throw new Error(
				`mail.assertNoneQueued() failed — expected zero queued messages, found ${this.#queued.length}.\n${describeCaptured(this.#queued)}`,
			);
		}
	}

	/**
	 * Shared body for the present/absent assertions. `expectPresent` flips the
	 * pass/fail sense so `assertSent` and `assertNotSent` share one code path.
	 */
	#assertPresence(
		method: string,
		bucket: string,
		entries: Capture[],
		arg: FakeMailPredicateArg | MailConstructor<BaseMail>,
		findFn: ((mail: BaseMail) => boolean) | undefined,
		expectPresent: boolean,
	): void {
		const found = isMailConstructor(arg)
			? entries.some(
					(e) =>
						e.mail !== undefined &&
						e.mail instanceof arg &&
						(findFn ? findFn(e.mail) : true),
				)
			: entries.some((e) => makeMatcher(arg)(e.message));
		if (found === expectPresent) return;
		const target = isMailConstructor(arg)
			? `an instance of ${arg.name}`
			: describePredicate(arg);
		const reason = expectPresent
			? `no ${bucket} message matches ${target}`
			: `at least one ${bucket} message matches ${target}`;
		throw new Error(
			`mail.${method}() failed — ${reason}.\n${describeCaptured(entries)}`,
		);
	}

	#assertCount(
		method: string,
		entries: Capture[],
		arg: number | MailConstructor<BaseMail>,
		count: number | undefined,
	): void {
		if (typeof arg === "number") {
			if (entries.length !== arg) {
				throw new Error(
					`mail.${method}() failed — expected ${arg}, found ${entries.length}.\n${describeCaptured(entries)}`,
				);
			}
			return;
		}
		const expected = count ?? 0;
		const actual = entries.filter(
			(e) => e.mail !== undefined && e.mail instanceof arg,
		).length;
		if (actual !== expected) {
			throw new Error(
				`mail.${method}() failed — expected ${expected} of ${arg.name}, found ${actual}.\n${describeCaptured(entries)}`,
			);
		}
	}
}

function isMailConstructor(
	arg: FakeMailPredicateArg | MailConstructor<BaseMail>,
): arg is MailConstructor<BaseMail> {
	return (
		typeof arg === "function" &&
		typeof arg.prototype === "object" &&
		arg.prototype instanceof BaseMail
	);
}

function cloneMessage(m: MailMessage): MailMessage {
	return {
		from: m.from,
		to: m.to.slice(),
		cc: m.cc.slice(),
		bcc: m.bcc.slice(),
		replyTo: m.replyTo,
		subject: m.subject,
		html: m.html,
		text: m.text,
		attachments: m.attachments.slice(),
		headers: { ...m.headers },
		priority: m.priority,
		messageId: m.messageId,
		inReplyTo: m.inReplyTo,
		references: m.references ? m.references.slice() : undefined,
	};
}

function makeMatcher(
	predicate: FakeMailPredicateArg,
): (m: MailMessage) => boolean {
	if (typeof predicate === "function") return predicate;
	const p = predicate;
	if (p.containing !== undefined && p.containing === "") {
		throw new Error(
			"FakeMail: `containing` predicate cannot be an empty string — it would match every captured message. Pass a non-empty needle.",
		);
	}
	return (m) => {
		if (p.from !== undefined && m.from !== p.from) return false;
		if (p.replyTo !== undefined && m.replyTo !== p.replyTo) return false;
		if (p.subject !== undefined && m.subject !== p.subject) return false;
		if (p.to !== undefined && !m.to.includes(p.to)) return false;
		if (p.cc !== undefined && !m.cc.includes(p.cc)) return false;
		if (p.bcc !== undefined && !m.bcc.includes(p.bcc)) return false;
		if (p.containing !== undefined) {
			const needle = p.containing;
			const inHtml = m.html?.includes(needle) ?? false;
			const inText = m.text?.includes(needle) ?? false;
			if (!inHtml && !inText) return false;
		}
		return true;
	};
}

function describePredicate(predicate: FakeMailPredicateArg): string {
	if (typeof predicate === "function") return "<function predicate>";
	return JSON.stringify(predicate);
}

function describeCaptured(captured: Capture[]): string {
	if (captured.length === 0) return "Captured: (none)";
	const lines = captured.map(
		(e, i) =>
			`  [${i}] to=[${e.message.to.join(", ")}] subject="${e.message.subject}" from="${e.message.from}"`,
	);
	return `Captured (${captured.length}):\n${lines.join("\n")}`;
}

/** A mailer that can enter/exit fake mode — structurally the rover `Mail` manager. */
export interface FakeableMailer {
	/** Activate fake mode and return the capturing {@link FakeMail}. */
	fake(): FakeMail;
	/** Exit fake mode. */
	restore(): void;
}

/**
 * `mailFake()` — a helix plugin (AdonisJS `mail.fake()` parity) that injects a
 * fresh {@link FakeMail} on the test context as `ctx.mail`, PER TEST, and
 * auto-restores the mailer afterwards via `ctx.cleanup`:
 *
 *   // tests/bootstrap.ts
 *   import { configure } from "@c9up/helix";
 *   import { mailFake } from "@c9up/rover/testing";
 *   await configure({ plugins: [mailFake(mailer)] });
 *
 *   test("sends welcome", async ({ mail }) => {
 *     await sendWelcome();
 *     mail.assertSent((m) => m.hasTo("user@example.com"));
 *   });
 *
 * The fake is activated lazily on first `ctx.mail` access (inside the test
 * frame) and torn down when that test ends — so capture never leaks between
 * tests. Uses the manager's own `fake()`/`restore()` (the Adonis pattern).
 */
/** The slice of helix's `PluginApi` this plugin uses. */
export type MailPluginHost = Pick<PluginApi, "context">;

export function mailFake(
	mailer: FakeableMailer,
): (api: MailPluginHost) => void {
	// Typed by what it touches, not by the whole `PluginApi`: a test wiring the
	// plugin had to build every field of it — `config`, `cliArgs`, `runner`,
	// `emitter`, `cleanup` — to exercise a function that reads one. Same shape
	// `@c9up/helix-plugin-ream` uses for its own host.
	return (api: MailPluginHost) => {
		api.context.getter("mail", (ctx) => {
			const fake = mailer.fake();
			ctx.cleanup(() => mailer.restore());
			return fake;
		});
	};
}

// Typing side of the plugin — importing `@c9up/rover/testing` augments the
// helix test context with `mail` (the helix pattern).
declare module "@c9up/helix" {
	interface TestContext {
		mail: FakeMail;
	}
}
