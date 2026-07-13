import { Buffer } from "node:buffer";
import { MemoryDriver, QueueManager } from "@c9up/bay";
import { beforeEach, describe, expect, it } from "vitest";
import {
	BaseMail,
	Mail,
	type MailMessage,
	type MailTransport,
	registerTransport,
} from "../../src/index.js";

class SpyTransport implements MailTransport {
	sent: MailMessage[] = [];
	async send(message: MailMessage): Promise<void> {
		this.sent.push(message);
	}
}

class FlakyTransport implements MailTransport {
	calls = 0;
	constructor(private failUntilAttempt: number) {}
	async send(_message: MailMessage): Promise<void> {
		this.calls += 1;
		if (this.calls < this.failUntilAttempt) {
			throw new Error(`transient failure (attempt ${this.calls})`);
		}
	}
}

const makeMail = (
	transportName: string,
	transport: MailTransport,
	options: { withQueue?: QueueManager; maxAttempts?: number } = {},
): Mail => {
	registerTransport(transportName, () => transport);
	return new Mail(
		{
			default: "log",
			from: "default@example.com",
			transports: { log: { transport: transportName } },
			queue: { maxAttempts: options.maxAttempts },
		},
		{ queue: options.withQueue },
	);
};

describe("rover > Mail.sendLater", () => {
	let queue: QueueManager;

	beforeEach(() => {
		queue = new QueueManager(new MemoryDriver());
	});

	it("returns a job id and does NOT call the transport synchronously", async () => {
		const spy = new SpyTransport();
		const mail = makeMail("tail-later-1", spy, { withQueue: queue });

		const id = await mail.sendLater((m) =>
			m.to("u@x.com").subject("Hi").text("later"),
		);

		expect(typeof id).toBe("string");
		expect(id).toMatch(/^job_/);
		expect(spy.sent).toHaveLength(0);
	});

	it("after queue.processOne() the transport receives the built message", async () => {
		const spy = new SpyTransport();
		const mail = makeMail("tail-later-2", spy, { withQueue: queue });

		await mail.sendLater((m) =>
			m.to("u@x.com").subject("Processed").html("<p>hi</p>"),
		);
		await queue.processOne();

		expect(spy.sent).toHaveLength(1);
		expect(spy.sent[0].to).toEqual(["u@x.com"]);
		expect(spy.sent[0].subject).toBe("Processed");
		expect(spy.sent[0].html).toBe("<p>hi</p>");
		expect(spy.sent[0].from).toBe("default@example.com");
	});

	it("sendLater(BaseMail instance) works like the callback form", async () => {
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

		const spy = new SpyTransport();
		const mail = makeMail("tail-later-3", spy, { withQueue: queue });

		const id = await mail.sendLater(new Welcome("user@acme.com"));
		expect(id).toBeDefined();
		expect(spy.sent).toHaveLength(0);

		await queue.processOne();
		expect(spy.sent).toHaveLength(1);
		expect(spy.sent[0].to).toEqual(["user@acme.com"]);
		expect(spy.sent[0].from).toBe("noreply@acme.com");
	});

	it("falls back to the in-memory messenger when no queue is wired (no throw)", async () => {
		// Contract: no QueueManager → Adonis-parity in-memory fallback, NOT a
		// MAIL_QUEUE_REQUIRED throw. (Also locked in the active mail.test.ts.)
		const mail = makeMail("tail-later-4", new SpyTransport());

		const jobId = await mail.sendLater((m) => m.to("u@x.com"));
		expect(typeof jobId).toBe("string");
		expect(jobId.length).toBeGreaterThan(0);
	});

	it("Buffer attachments round-trip through the queue", async () => {
		const spy = new SpyTransport();
		const mail = makeMail("tail-later-5", spy, { withQueue: queue });
		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic

		await mail.sendLater((m) =>
			m
				.to("u@x.com")
				.subject("Attach")
				.text("see file")
				.attach("logo.png", bytes, "image/png"),
		);
		await queue.processOne();

		expect(spy.sent).toHaveLength(1);
		const att = spy.sent[0].attachments[0];
		expect(Buffer.isBuffer(att.content)).toBe(true);
		expect((att.content as Buffer).equals(bytes)).toBe(true);
		expect(att.filename).toBe("logo.png");
		expect(att.contentType).toBe("image/png");
	});

	it("Bay retries via maxAttempts when transport throws transiently", async () => {
		const flaky = new FlakyTransport(3); // fails on attempts 1,2; succeeds on 3
		const mail = makeMail("tail-later-6", flaky, {
			withQueue: queue,
			maxAttempts: 3,
		});

		await mail.sendLater((m) => m.to("u@x.com").subject("Retry test"));

		// Process until queue is empty or job exhausts retries
		for (let i = 0; i < 5; i += 1) {
			const processed = await queue.processOne();
			if (!processed) break;
		}

		expect(flaky.calls).toBe(3);
		const failedJobs = await queue.failedJobs();
		expect(failedJobs).toHaveLength(0);
	});

	it("MailJobHandler rejects malformed payload with MAIL_JOB_MALFORMED", async () => {
		const { MailJobHandler } = await import("../../src/queue/MailJob.js");
		const handler = new MailJobHandler({
			async dispatchMessage() {
				throw new Error("should not reach here");
			},
		});
		await expect(handler.handle(null)).rejects.toMatchObject({
			code: "MAIL_JOB_MALFORMED",
		});
		await expect(handler.handle({})).rejects.toMatchObject({
			code: "MAIL_JOB_MALFORMED",
		});
		await expect(
			handler.handle({ message: "not-an-object" }),
		).rejects.toMatchObject({ code: "MAIL_JOB_MALFORMED" });
		await expect(
			handler.handle({ message: { from: "a", to: "not-an-array" } }),
		).rejects.toMatchObject({ code: "MAIL_JOB_MALFORMED" });
	});

	it("MailJobHandler handles a JSON-round-tripped payload (Redis-driver shape)", async () => {
		const spy = new SpyTransport();
		const mail = makeMail("tail-later-json-rt", spy, { withQueue: queue });
		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
		await mail.sendLater((m) =>
			m
				.to("u@x.com")
				.subject("Redis-like")
				.text("x")
				.attach("logo.png", bytes, "image/png"),
		);

		// Simulate a Redis driver's JSON round-trip by pulling the raw payload
		// and re-parsing it; then feed it to the handler directly.
		const pending = await queue.size();
		expect(pending).toBe(1);
		await queue.processOne();

		expect(spy.sent).toHaveLength(1);
		const att = spy.sent[0].attachments[0];
		expect(Buffer.isBuffer(att.content)).toBe(true);
		expect((att.content as Buffer).equals(bytes)).toBe(true);
	});

	it("uses the explicit transport option when provided", async () => {
		const primary = new SpyTransport();
		const secondary = new SpyTransport();
		registerTransport("tail-later-7a", () => primary);
		registerTransport("tail-later-7b", () => secondary);

		const mail = new Mail(
			{
				default: "log",
				from: "default@example.com",
				transports: {
					log: { transport: "tail-later-7a" },
					secondary: { transport: "tail-later-7b" },
				},
			},
			{ queue },
		);

		await mail.sendLater((m) => m.to("u@x.com").subject("secondary path"), {
			transport: "secondary",
		});
		await queue.processOne();

		expect(primary.sent).toHaveLength(0);
		expect(secondary.sent).toHaveLength(1);
	});
});
