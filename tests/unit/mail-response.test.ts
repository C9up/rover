import { afterEach, describe, expect, it } from "vitest";
import {
	BaseMail,
	Mail,
	MailResponse,
	type MailSentEvent,
	type MailTransport,
	registerTransport,
} from "../../src/index.js";
import { type FakeSmtp, startFakeSmtp } from "../__helpers__/fakeSmtp.js";

let server: FakeSmtp | undefined;

afterEach(async () => {
	await server?.close();
	server = undefined;
});

class Welcome extends BaseMail {
	prepare() {
		this.message.to("bob@example.com").subject("Hi").text("x");
	}
}

describe("rover > send() resolves to a MailResponse (AdonisJS shape)", () => {
	it("over SMTP: the server's message id, nodemailer's envelope and the raw info", async () => {
		server = await startFakeSmtp();
		const sent: MailSentEvent[] = [];
		const mail = new Mail(
			{
				default: "smtp",
				from: "app@example.com",
				mailers: {
					smtp: {
						transport: "smtp",
						host: "127.0.0.1",
						port: server.port,
						retry: { maxAttempts: 1 },
					},
				},
			},
			{ hooks: { onSent: (event) => sent.push(event) } },
		);
		const response = await mail.send((m) =>
			m.to("bob@example.com").cc("cc@example.com").subject("s").text("x"),
		);
		expect(response).toBeInstanceOf(MailResponse);
		expect(response.messageId).toMatch(/^<.+@example\.com>$/);
		expect(response.envelope).toEqual({
			from: "app@example.com",
			to: ["bob@example.com", "cc@example.com"],
		});
		expect(response.original).toMatchObject({ messageId: response.messageId });
		expect(sent[0]?.messageId).toBe(response.messageId);
		expect(sent[0]?.response).toBe(response);
	});

	it("through a provider transport, from sendCompiled() and a mailer's send()", async () => {
		const transport: MailTransport = {
			async send() {
				return { providerId: "prov-1" };
			},
		};
		registerTransport("response-spy", () => transport);
		const mail = new Mail({
			default: "spy",
			from: "app@example.com",
			mailers: { spy: { transport: "response-spy" } },
		});
		const viaMailer = await mail.use("spy").send(new Welcome());
		expect(viaMailer.messageId).toBe("prov-1");
		expect(viaMailer.envelope).toEqual({
			from: "app@example.com",
			to: ["bob@example.com"],
		});

		const compiled = await mail.sendCompiled({
			from: "app@example.com",
			to: ["a@example.com"],
			cc: [],
			bcc: [],
			subject: "s",
			text: "x",
			attachments: [],
			headers: {},
			envelope: { from: "bounce@example.com", to: "env@example.com" },
		});
		expect(compiled.envelope).toEqual({
			from: "bounce@example.com",
			to: ["env@example.com"],
		});
	});

	it("in fake mode too", async () => {
		const mail = new Mail({
			default: "log",
			from: "app@example.com",
			mailers: { log: { transport: "log" } },
		});
		mail.fake();
		const response = await mail.send(new Welcome());
		expect(response).toBeInstanceOf(MailResponse);
		expect(response.messageId).toMatch(/^[0-9a-f]{32}$/);
	});
});
