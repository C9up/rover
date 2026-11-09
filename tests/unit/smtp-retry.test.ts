import { afterEach, describe, expect, it } from "vitest";
import { Mail } from "../../src/index.js";
import { type FakeSmtp, startFakeSmtp } from "../__helpers__/fakeSmtp.js";

let server: FakeSmtp | undefined;

afterEach(async () => {
	await server?.close();
	server = undefined;
});

function mailFor(port: number, extra: Record<string, unknown> = {}): Mail {
	return new Mail({
		default: "smtp",
		from: "app@example.com",
		mailers: {
			smtp: {
				transport: "smtp",
				host: "127.0.0.1",
				port,
				retry: { maxAttempts: 3, baseDelayMs: 1, factor: 1 },
				...extra,
			},
		},
	});
}

const send = (mail: Mail) =>
	mail.send((m) => m.to("bob@example.com").subject("s").text("x"));

const count = (commands: string[], verb: string) =>
	commands.filter((c) => c.toUpperCase().startsWith(verb)).length;

describe("rover > SMTP retry follows RFC 5321 reply classes", () => {
	it("does not repeat a permanent 5xx rejection (550 user unknown)", async () => {
		server = await startFakeSmtp({ rcptReply: "550 5.1.1 user unknown" });
		await expect(send(mailFor(server.port))).rejects.toMatchObject({
			code: "E_MAIL_PROVIDER_ERROR",
			context: { upstreamStatus: "550", attempts: "1" },
		});
		expect(count(server.commands(), "RCPT")).toBe(1);
	});

	it.each([
		"451 4.7.1 greylisted, try again later",
		"421 4.7.0 too many connections",
		"452 4.2.2 mailbox full",
	])("retries a transient 4xx reply (%s) up to maxAttempts", async (reply) => {
		server = await startFakeSmtp({ rcptReply: reply });
		await expect(send(mailFor(server.port))).rejects.toMatchObject({
			context: { attempts: "3" },
		});
		expect(count(server.commands(), "RCPT")).toBe(3);
	});

	it("never retries an authentication failure", async () => {
		server = await startFakeSmtp({ authReply: "535 5.7.8 bad credentials" });
		await expect(
			send(
				mailFor(server.port, { user: "u", pass: "p", allowInsecureAuth: true }),
			),
		).rejects.toMatchObject({ context: { attempts: "1" } });
		expect(count(server.commands(), "AUTH")).toBe(1);
	});

	it("never retries a temporary-looking authentication failure either", async () => {
		server = await startFakeSmtp({ authReply: "454 4.7.0 auth unavailable" });
		await expect(
			send(
				mailFor(server.port, { user: "u", pass: "p", allowInsecureAuth: true }),
			),
		).rejects.toMatchObject({ context: { attempts: "1" } });
		expect(count(server.commands(), "AUTH")).toBe(1);
	});
});
