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
 * In-memory transport for tests — captures every `send(message)` call and
 * exposes Adonis/Laravel-style `assertSent` / `assertNotSent` helpers.
 *
 * Not re-exported from the main barrel; reach via `@c9up/rover/testing`.
 */
export class FakeMail implements MailTransport {
	#captured: MailMessage[] = [];

	async send(message: MailMessage): Promise<MailSendOutcome> {
		this.#captured.push(message);
		return undefined;
	}

	/**
	 * Return a defensive snapshot of captured messages. Each message is cloned
	 * (shallow-per-field with array copies) so test-side mutations can't bleed
	 * back into the internal capture store — avoids cross-test contamination.
	 */
	getSent(): MailMessage[] {
		return this.#captured.map((m) => ({
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
		}));
	}

	reset(): void {
		this.#captured = [];
	}

	assertSent(predicate: FakeMailPredicateArg): void {
		const match = makeMatcher(predicate);
		if (this.#captured.some(match)) return;
		throw new Error(
			`mail.assertSent() failed — no captured message matches ${describePredicate(predicate)}.\n${describeCaptured(this.#captured)}`,
		);
	}

	assertNotSent(predicate: FakeMailPredicateArg): void {
		const match = makeMatcher(predicate);
		const found = this.#captured.find(match);
		if (!found) return;
		throw new Error(
			`mail.assertNotSent() failed — at least one captured message matches ${describePredicate(predicate)}.\n${describeCaptured(this.#captured)}`,
		);
	}
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

function describeCaptured(captured: MailMessage[]): string {
	if (captured.length === 0) return "Captured: (none)";
	const lines = captured.map(
		(m, i) =>
			`  [${i}] to=[${m.to.join(", ")}] subject="${m.subject}" from="${m.from}"`,
	);
	return `Captured (${captured.length}):\n${lines.join("\n")}`;
}
