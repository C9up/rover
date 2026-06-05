import { describe, expect, it } from "vitest";
import { LogTransport, Mail, MessageBuilder } from "../../src/index.js";

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

	it("use() returns a specific transport", () => {
		const mail = new Mail({
			default: "log",
			from: "test@example.com",
			transports: { log: { transport: "log" } },
		});
		const transport = mail.use("log");
		expect(transport).toBeInstanceOf(LogTransport);
	});

	it("use() throws on unknown transport name", () => {
		const mail = new Mail({
			default: "log",
			from: "test@example.com",
			transports: { log: { transport: "log" } },
		});
		expect(() => mail.use("nope")).toThrow("not configured");
	});
});
