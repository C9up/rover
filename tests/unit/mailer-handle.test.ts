/**
 * `mail.use(name?)` hands back a `Mailer` bound to one transport. Without a
 * name it is the configured default; every per-message method it carries
 * (`send`, `sendLater`, `sendCompiled`, `sendLaterCompiled`, `close`) goes
 * through that mailer's transport, never the default's.
 */
import { MemoryDriver, QueueManager } from "@c9up/bay";
import { describe, expect, it } from "vitest";
import {
	Mail,
	type MailMessage,
	type MailSendOutcome,
	type MailTransport,
	registerTransport,
} from "../../src/index.js";

class SpyTransport implements MailTransport {
	sent: MailMessage[] = [];
	closed = 0;
	async send(message: MailMessage): Promise<MailSendOutcome> {
		this.sent.push(message);
		return undefined;
	}
	async close(): Promise<void> {
		this.closed += 1;
	}
}

const compiled = (subject: string): MailMessage => ({
	from: "app@example.com",
	to: ["user@example.com"],
	cc: [],
	bcc: [],
	subject,
	text: "body",
	attachments: [],
	headers: {},
});

function twoMailers(tag: string, queue?: QueueManager) {
	const primary = new SpyTransport();
	const secondary = new SpyTransport();
	registerTransport(`spy-handle-${tag}-primary`, () => primary);
	registerTransport(`spy-handle-${tag}-secondary`, () => secondary);
	const mail = new Mail(
		{
			default: "primary",
			from: "app@example.com",
			mailers: {
				primary: { transport: `spy-handle-${tag}-primary` },
				secondary: { transport: `spy-handle-${tag}-secondary` },
			},
		},
		{ queue },
	);
	return { mail, primary, secondary };
}

describe("rover > mail.use()", () => {
	it("returns the default mailer when no name is given", async () => {
		const { mail, primary, secondary } = twoMailers("default");
		const mailer = mail.use();
		expect(mailer.name).toBe("primary");
		expect(mailer).toBe(mail.use("primary"));
		await mailer.send((m) => m.to("user@example.com").subject("Hi").text("b"));
		expect(primary.sent).toHaveLength(1);
		expect(secondary.sent).toHaveLength(0);
	});

	it("still refuses a name that is not declared", () => {
		const { mail } = twoMailers("unknown");
		expect(() => mail.use("absent")).toThrow(/mailer 'absent' is not declared/);
	});
});

describe("rover > Mailer per-mailer methods", () => {
	it("sendCompiled goes through the mailer's own transport", async () => {
		const { mail, primary, secondary } = twoMailers("compiled");
		const response = await mail
			.use("secondary")
			.sendCompiled(compiled("compiled"));
		expect(response.messageId).toEqual(expect.any(String));
		expect(secondary.sent.map((m) => m.subject)).toEqual(["compiled"]);
		expect(primary.sent).toHaveLength(0);
	});

	it("sendLaterCompiled queues for the mailer's own transport", async () => {
		const queue = new QueueManager(new MemoryDriver());
		const { mail, primary, secondary } = twoMailers("later", queue);
		const id = await mail
			.use("secondary")
			.sendLaterCompiled(compiled("queued"));
		expect(typeof id).toBe("string");
		expect(secondary.sent).toHaveLength(0);
		await queue.processOne();
		expect(secondary.sent.map((m) => m.subject)).toEqual(["queued"]);
		expect(primary.sent).toHaveLength(0);
	});

	it("close() closes only the mailer's own transport", async () => {
		const { mail, primary, secondary } = twoMailers("close");
		mail.use("primary");
		const mailer = mail.use("secondary");
		await mailer.close();
		expect(secondary.closed).toBe(1);
		expect(primary.closed).toBe(0);
		// The pool is dropped with it: the next send builds a fresh transport.
		await mailer.sendCompiled(compiled("after close"));
		expect(secondary.sent).toHaveLength(1);
	});
});
