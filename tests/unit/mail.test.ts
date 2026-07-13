import { describe, expect, it } from "vitest";
import { Mail, Mailer, MessageBuilder } from "../../src/index.js";

describe("rover > Mail", () => {
	it("creates a mail instance with log transport", () => {
		const mail = new Mail({
			default: "log",
			from: "test@example.com",
			transports: { log: { transport: "log" } },
		});
		expect(mail).toBeDefined();
	});

	it("sends via log transport without throwing", async () => {
		const mail = new Mail({
			default: "log",
			from: "test@example.com",
			transports: { log: { transport: "log" } },
		});
		await mail.send((message) => {
			message.to("user@example.com");
			message.subject("Test");
			message.text("Hello");
		});
	});

	it("throws on unknown transport", () => {
		const mail = new Mail({
			default: "unknown",
			from: "test@example.com",
			transports: {},
		});
		expect(mail.send((m) => m.to("a@b.com"))).rejects.toThrow("not configured");
	});

	it("builds a message with all fields", async () => {
		const builder = new MessageBuilder();
		builder
			.from("a@b.com")
			.to("c@d.com")
			.cc("e@f.com")
			.bcc("g@h.com")
			.replyTo("r@s.com")
			.subject("Subj")
			.html("<p>Hi</p>")
			.text("Hi")
			.attach("file.txt", "content", "text/plain")
			.header("X-Custom", "val");

		const msg = await builder.build();
		expect(msg.from).toBe("a@b.com");
		expect(msg.to).toEqual(["c@d.com"]);
		expect(msg.cc).toEqual(["e@f.com"]);
		expect(msg.bcc).toEqual(["g@h.com"]);
		expect(msg.replyTo).toBe("r@s.com");
		expect(msg.subject).toBe("Subj");
		expect(msg.html).toBe("<p>Hi</p>");
		expect(msg.text).toBe("Hi");
		expect(msg.attachments).toHaveLength(1);
		expect(msg.headers["X-Custom"]).toBe("val");
	});

	it("use() returns a Mailer bound to the named transport", () => {
		const mail = new Mail({
			default: "log",
			from: "test@example.com",
			transports: { log: { transport: "log" } },
		});
		// AdonisJS parity: use(name) returns a Mailer (send/sendLater), not the
		// raw transport, so `mail.use('log').send(cb)` works.
		const mailer = mail.use("log");
		expect(mailer).toBeInstanceOf(Mailer);
		expect(typeof mailer.send).toBe("function");
	});

	it("use() throws on unknown transport name", () => {
		const mail = new Mail({
			default: "log",
			from: "test@example.com",
			transports: { log: { transport: "log" } },
		});
		expect(() => mail.use("nope")).toThrow("not configured");
	});

	it("sendLater() without a queue falls back to the in-memory messenger (no throw, returns a job id)", async () => {
		// Contract lock: no `QueueManager` wired → the Adonis-parity in-memory
		// fallback (immediate microtask dispatch), NOT a `MAIL_QUEUE_REQUIRED`
		// throw. Runs without @c9up/bay so it stays in the active suite (the
		// queue-driven cases live in the bay-gated send-later.test.ts).
		const mail = new Mail({
			default: "log",
			from: "test@example.com",
			transports: { log: { transport: "log" } },
		});
		const jobId = await mail.sendLater((m) =>
			m.to("user@example.com").subject("Hi"),
		);
		expect(typeof jobId).toBe("string");
		expect(jobId.length).toBeGreaterThan(0);
	});
});
