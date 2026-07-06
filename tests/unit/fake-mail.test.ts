import { describe, expect, it } from "vitest";
import {
	BaseMail,
	Mail,
	type MailMessage,
	type MailTransport,
	registerTransport,
} from "../../src/index.js";
import { FakeMail } from "../../src/testing/FakeMail.js";

class TailTransport implements MailTransport {
	sent: MailMessage[] = [];
	async send(message: MailMessage): Promise<void> {
		this.sent.push(message);
	}
}

const makeMail = (transportName: string, transport: MailTransport): Mail => {
	registerTransport(transportName, () => transport);
	return new Mail({
		default: "log",
		from: "default@example.com",
		transports: { log: { transport: transportName } },
	});
};

describe("rover > FakeMail / Mail.fake()", () => {
	it("mail.fake() swaps default transport; send() captures into the fake", async () => {
		const tail = new TailTransport();
		const mail = makeMail("tail-fake-1", tail);

		const fake = mail.fake();
		await mail.send((m) =>
			m.to("user@example.com").subject("Hello").text("hi"),
		);

		expect(fake.getSent()).toHaveLength(1);
		expect(tail.sent).toHaveLength(0);
		expect(fake.getSent()[0].to).toEqual(["user@example.com"]);
	});

	it("assertSent({ to }) passes when address is a recipient", async () => {
		const mail = makeMail("tail-fake-2", new TailTransport());
		const fake = mail.fake();
		await mail.send((m) => m.to("user@x.com").subject("S"));

		expect(() => fake.assertSent({ to: "user@x.com" })).not.toThrow();
	});

	it("assertSent({ to }) fails with a descriptive error listing captured messages", async () => {
		const mail = makeMail("tail-fake-3", new TailTransport());
		const fake = mail.fake();
		await mail.send((m) => m.to("other@y.com").subject("Welcome"));
		await mail.send((m) => m.to("also@y.com").subject("Reminder"));

		expect(() => fake.assertSent({ to: "user@x.com" })).toThrow(
			/no sent message matches.*Captured \(2\)/s,
		);
	});

	it("assertSent({ subject }) — exact match semantics", async () => {
		const mail = makeMail("tail-fake-4", new TailTransport());
		const fake = mail.fake();
		await mail.send((m) => m.to("u@x.com").subject("Welcome"));

		expect(() => fake.assertSent({ subject: "Welcome" })).not.toThrow();
		expect(() => fake.assertSent({ subject: "welcome" })).toThrow(
			/mail\.assertSent\(\) failed/,
		);
	});

	it("assertSent({ containing }) matches substring in html OR text", async () => {
		const mail = makeMail("tail-fake-5", new TailTransport());
		const fake = mail.fake();
		await mail.send((m) =>
			m.to("u@x.com").subject("X").html("<p>reset your password here</p>"),
		);
		await mail.send((m) => m.to("u@x.com").subject("X").text("hello world"));

		expect(() =>
			fake.assertSent({ containing: "reset your password" }),
		).not.toThrow();
		expect(() => fake.assertSent({ containing: "hello world" })).not.toThrow();
		expect(() => fake.assertSent({ containing: "never sent" })).toThrow(
			/mail\.assertSent\(\) failed/,
		);
	});

	it("assertSent((m) => boolean) — function predicate", async () => {
		const mail = makeMail("tail-fake-6", new TailTransport());
		const fake = mail.fake();
		await mail.send((m) =>
			m.to("u@x.com").subject("X").attach("file.txt", "content", "text/plain"),
		);

		expect(() =>
			fake.assertSent((m) => m.attachments.length > 0),
		).not.toThrow();
		expect(() => fake.assertSent((m) => m.attachments.length > 5)).toThrow(
			/mail\.assertSent\(\) failed/,
		);
	});

	it("assertNotSent() passes when no match, throws when any match", async () => {
		const mail = makeMail("tail-fake-7", new TailTransport());
		const fake = mail.fake();
		await mail.send((m) => m.to("user@x.com").subject("Hi"));

		expect(() => fake.assertNotSent({ to: "nobody@x.com" })).not.toThrow();
		expect(() => fake.assertNotSent({ to: "user@x.com" })).toThrow(
			/at least one sent message matches/,
		);
	});

	it("reset() clears captured messages", async () => {
		const mail = makeMail("tail-fake-8", new TailTransport());
		const fake = mail.fake();
		await mail.send((m) => m.to("u@x.com").subject("S"));
		expect(fake.getSent()).toHaveLength(1);

		fake.reset();
		expect(fake.getSent()).toHaveLength(0);
	});

	it("fake() twice throws (prevents nested fakes)", () => {
		const mail = makeMail("tail-fake-9", new TailTransport());
		mail.fake();
		expect(() => mail.fake()).toThrow("already active");
	});

	it("restore() re-installs the original transport", async () => {
		const tail = new TailTransport();
		const mail = makeMail("tail-fake-10", tail);

		mail.fake();
		await mail.send((m) => m.to("fake@x.com").subject("S"));
		expect(tail.sent).toHaveLength(0);

		mail.restore();
		await mail.send((m) => m.to("real@x.com").subject("S"));
		expect(tail.sent).toHaveLength(1);
		expect(tail.sent[0].to).toEqual(["real@x.com"]);
	});

	it("captures BaseMail instance sends as built MailMessage", async () => {
		class Welcome extends BaseMail {
			from = "noreply@acme.com";
			subject = "Welcome!";
			constructor(private email: string) {
				super();
			}
			override prepare(): void {
				this.message.to(this.email).html("<p>hi</p>");
			}
		}

		const mail = makeMail("tail-fake-11", new TailTransport());
		const fake = mail.fake();
		await mail.send(new Welcome("user@acme.com"));

		expect(fake.getSent()).toHaveLength(1);
		expect(fake.getSent()[0].to).toEqual(["user@acme.com"]);
		expect(fake.getSent()[0].subject).toBe("Welcome!");
		expect(fake.getSent()[0].from).toBe("noreply@acme.com");
	});

	it("rejects empty `containing` needle (would match everything)", async () => {
		const mail = makeMail("tail-fake-empty-containing", new TailTransport());
		const fake = mail.fake();
		await mail.send((m) => m.to("u@x.com").subject("S").html("<p>Hi</p>"));

		expect(() => fake.assertSent({ containing: "" })).toThrow(
			/cannot be an empty string/,
		);
	});

	it("getSent() returns defensive snapshot; external mutation doesn't affect capture", async () => {
		const mail = makeMail("tail-fake-snapshot", new TailTransport());
		const fake = mail.fake();
		await mail.send((m) => m.to("u@x.com").subject("S").html("<p>Hi</p>"));

		const snapshot = fake.getSent();
		snapshot[0].to.push("injected@evil.com");
		snapshot[0].subject = "mutated";

		const fresh = fake.getSent();
		expect(fresh[0].to).toEqual(["u@x.com"]);
		expect(fresh[0].subject).toBe("S");
	});

	it("re-fake cycle (fake → restore → fake) works", async () => {
		const tail = new TailTransport();
		const mail = makeMail("tail-fake-refake", tail);

		const fake1 = mail.fake();
		await mail.send((m) => m.to("a@x.com").subject("1"));
		mail.restore();

		const fake2 = mail.fake();
		await mail.send((m) => m.to("b@x.com").subject("2"));

		expect(fake1.getSent()).toHaveLength(1);
		expect(fake2.getSent()).toHaveLength(1);
		expect(fake2.getSent()[0].to).toEqual(["b@x.com"]);
		expect(tail.sent).toHaveLength(0);
	});

	it("FakeMail implements MailTransport (captures via its own send())", async () => {
		const fake = new FakeMail();
		await fake.send({
			from: "a@x.com",
			to: ["b@x.com"],
			cc: [],
			bcc: [],
			subject: "Direct",
			attachments: [],
			headers: {},
		});
		expect(fake.getSent()).toHaveLength(1);
	});
});
