/**
 * The queued half of `mail.fake()`.
 *
 * `sendLater()` captures into a separate bucket from `send()`, and that bucket
 * had no test at all — so `assertQueued`, the counts and `assertNone*` were a
 * shipped assertion API nobody had ever seen answer. An assertion that cannot
 * fail is a test that cannot catch anything.
 */
import { describe, expect, it } from "vitest";
import {
	BaseMail,
	Mail,
	type MailMessage,
	type MailTransport,
	registerTransport,
} from "../../src/index.js";

class TailTransport implements MailTransport {
	sent: MailMessage[] = [];
	async send(message: MailMessage): Promise<void> {
		this.sent.push(message);
	}
}

let seq = 0;
const makeMail = (): Mail => {
	const name = `tail-queued-${++seq}`;
	registerTransport(name, () => new TailTransport());
	return new Mail({
		default: "log",
		from: "default@example.com",
		transports: { log: { transport: name } },
	});
};

class WelcomeMail extends BaseMail {
	from = "noreply@acme.test";
	subject = "Welcome!";
	constructor(readonly email: string) {
		super();
	}
	override prepare(): void {
		this.message.to(this.email).html("<p>hi</p>");
	}
}

class ReceiptMail extends BaseMail {
	from = "billing@acme.test";
	subject = "Your receipt";
	override prepare(): void {
		this.message.to("customer@acme.test").text("thanks");
	}
}

describe("rover > the queued bucket", () => {
	it("captures sendLater() instead of dispatching it", async () => {
		const mail = makeMail();
		const fake = mail.fake();

		const jobId = await mail.sendLater((m) =>
			m.to("user@acme.test").subject("Later"),
		);

		expect(jobId).toMatch(/^fake_/);
		expect(fake.getQueued()).toHaveLength(1);
		// The two buckets are separate: a queued message was never sent.
		expect(fake.getSent()).toHaveLength(0);
		expect(fake.getQueued()[0].subject).toBe("Later");
	});

	it("hands back a snapshot, so a caller cannot edit the capture", async () => {
		const mail = makeMail();
		const fake = mail.fake();
		await mail.sendLater((m) => m.to("user@acme.test").subject("Later"));

		fake.getQueued()[0].to.push("injected@evil.test");

		expect(fake.getQueued()[0].to).toEqual(["user@acme.test"]);
	});

	it("answers assertQueued on a predicate, and assertNotQueued on its opposite", async () => {
		const mail = makeMail();
		const fake = mail.fake();
		await mail.sendLater((m) =>
			m.to("user@acme.test").subject("Later").text("the body"),
		);

		expect(() => {
			fake.assertQueued({ to: "user@acme.test" });
			fake.assertQueued({ subject: "Later" });
			fake.assertQueued({ containing: "the body" });
			fake.assertQueued((m) => m.subject === "Later");
			fake.assertNotQueued({ to: "someone@else.test" });
		}).not.toThrow();

		expect(() => fake.assertQueued({ to: "someone@else.test" })).toThrow(
			/assertQueued/,
		);
		expect(() => fake.assertNotQueued({ to: "user@acme.test" })).toThrow(
			/assertNotQueued/,
		);
	});

	it("answers assertQueued on the mail class it came from", async () => {
		const mail = makeMail();
		const fake = mail.fake();
		await mail.sendLater(new WelcomeMail("ada@acme.test"));

		expect(() => {
			fake.assertQueued(WelcomeMail);
			fake.assertQueued(WelcomeMail, (m) => m.email === "ada@acme.test");
			fake.assertNotQueued(ReceiptMail);
		}).not.toThrow();

		expect(() => fake.assertQueued(ReceiptMail)).toThrow(/ReceiptMail/);
		expect(() =>
			fake.assertQueued(WelcomeMail, (m) => m.email === "grace@acme.test"),
		).toThrow(/assertQueued/);
	});

	it("names the captured messages when an assertion fails", async () => {
		const mail = makeMail();
		const fake = mail.fake();
		await mail.sendLater((m) => m.to("user@acme.test").subject("Later"));

		// Without the capture listing, a failing assertion says nothing about
		// what the code actually queued.
		expect(() => fake.assertQueued({ subject: "Other" })).toThrow(
			/user@acme\.test/,
		);
	});
});

describe("rover > counting what was sent and queued", () => {
	it("counts both buckets separately", async () => {
		const mail = makeMail();
		const fake = mail.fake();
		await mail.send((m) => m.to("a@acme.test").subject("S"));
		await mail.sendLater((m) => m.to("b@acme.test").subject("Q"));
		await mail.sendLater((m) => m.to("c@acme.test").subject("Q"));

		expect(() => {
			fake.assertSentCount(1);
			fake.assertQueuedCount(2);
		}).not.toThrow();

		expect(() => fake.assertSentCount(2)).toThrow(/expected 2, found 1/);
		expect(() => fake.assertQueuedCount(1)).toThrow(/expected 1, found 2/);
	});

	it("counts per mail class", async () => {
		const mail = makeMail();
		const fake = mail.fake();
		await mail.send(new WelcomeMail("ada@acme.test"));
		await mail.send(new WelcomeMail("grace@acme.test"));
		await mail.sendLater(new ReceiptMail());

		expect(() => {
			fake.assertSentCount(WelcomeMail, 2);
			fake.assertSentCount(ReceiptMail, 0);
			fake.assertQueuedCount(ReceiptMail, 1);
		}).not.toThrow();

		expect(() => fake.assertSentCount(WelcomeMail, 1)).toThrow(
			/expected 1 of WelcomeMail, found 2/,
		);
	});

	it("asserts nothing happened at all", async () => {
		const mail = makeMail();
		const fake = mail.fake();

		expect(() => {
			fake.assertNoneSent();
			fake.assertNoneQueued();
		}).not.toThrow();

		await mail.send((m) => m.to("a@acme.test").subject("S"));
		await mail.sendLater((m) => m.to("b@acme.test").subject("Q"));

		expect(() => fake.assertNoneSent()).toThrow(/found 1/);
		expect(() => fake.assertNoneQueued()).toThrow(/found 1/);
	});
});

describe("rover > every field a predicate can match on", () => {
	it("matches from, replyTo, cc and bcc, and refuses a message that differs", async () => {
		const mail = makeMail();
		const fake = mail.fake();
		await mail.send((m) =>
			m
				.from("ada@acme.test")
				.to("grace@acme.test")
				.cc("cc@acme.test")
				.bcc("bcc@acme.test")
				.replyTo("reply@acme.test")
				.subject("S"),
		);

		expect(() => {
			fake.assertSent({ from: "ada@acme.test" });
			fake.assertSent({ replyTo: "reply@acme.test" });
			fake.assertSent({ cc: "cc@acme.test" });
			fake.assertSent({ bcc: "bcc@acme.test" });
		}).not.toThrow();

		for (const predicate of [
			{ from: "someone@else.test" },
			{ replyTo: "someone@else.test" },
			{ cc: "someone@else.test" },
			{ bcc: "someone@else.test" },
		]) {
			expect(() => fake.assertSent(predicate)).toThrow(/assertSent/);
		}
	});

	it("takes several fields at once, all of which must hold", async () => {
		const mail = makeMail();
		const fake = mail.fake();
		await mail.send((m) =>
			m.from("ada@acme.test").to("grace@acme.test").subject("S"),
		);

		expect(() =>
			fake.assertSent({ from: "ada@acme.test", subject: "S" }),
		).not.toThrow();
		// One field matching is not the message matching.
		expect(() =>
			fake.assertSent({ from: "ada@acme.test", subject: "Other" }),
		).toThrow(/assertSent/);
	});
});
