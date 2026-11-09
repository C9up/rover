import { afterEach, describe, expect, it } from "vitest";
import { Mail, SmtpTransport } from "../../src/index.js";
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
				retry: { maxAttempts: 1 },
				...extra,
			},
		},
	});
}

const send = (mail: Mail) =>
	mail.send((m) => m.to("bob@example.com").subject("s").text("x"));

describe("rover > SMTP credentials never travel before TLS", () => {
	it("refuses to authenticate when the server does not offer STARTTLS (stripped by a MITM)", async () => {
		server = await startFakeSmtp({ advertiseStartTls: false });
		const mail = mailFor(server.port, {
			user: "smtpuser",
			pass: "S3cretPass!",
		});
		await expect(send(mail)).rejects.toMatchObject({
			code: "E_MAIL_PROVIDER_ERROR",
		});
		const commands = server.commands();
		expect(commands.some((c) => c.toUpperCase().startsWith("AUTH"))).toBe(
			false,
		);
		expect(commands.some((c) => c.toUpperCase().startsWith("MAIL"))).toBe(
			false,
		);
	});

	it("refuses when STARTTLS is advertised but the upgrade fails", async () => {
		server = await startFakeSmtp({ advertiseStartTls: true });
		const mail = mailFor(server.port, { user: "u", pass: "p" });
		await expect(send(mail)).rejects.toMatchObject({
			code: "E_MAIL_PROVIDER_ERROR",
		});
		expect(
			server.commands().some((c) => c.toUpperCase().startsWith("AUTH")),
		).toBe(false);
	});

	it("an OAuth2 `auth` object counts as credentials too", async () => {
		server = await startFakeSmtp({ advertiseStartTls: false });
		const mail = mailFor(server.port, {
			auth: { type: "OAuth2", user: "u", accessToken: "tok" },
		});
		await expect(send(mail)).rejects.toMatchObject({
			code: "E_MAIL_PROVIDER_ERROR",
		});
		expect(
			server.commands().some((c) => c.toUpperCase().startsWith("AUTH")),
		).toBe(false);
	});

	it("`allowInsecureAuth: true` is the named escape hatch for a local dev server", async () => {
		server = await startFakeSmtp({ advertiseStartTls: false });
		const mail = mailFor(server.port, {
			user: "u",
			pass: "p",
			allowInsecureAuth: true,
		});
		await send(mail);
		expect(
			server.commands().some((c) => c.toUpperCase().startsWith("AUTH")),
		).toBe(true);
	});

	it("without credentials, plaintext delivery is unchanged", async () => {
		server = await startFakeSmtp({ advertiseStartTls: false });
		await send(mailFor(server.port));
		expect(server.commands()).toContain("RCPT TO:<bob@example.com>");
	});

	it.each([
		["requireTLS: false", { requireTLS: false }],
		["ignoreTLS: true", { ignoreTLS: true }],
		["opportunisticTLS: true", { opportunisticTLS: true }],
	])(
		"refuses %s alongside credentials unless allowInsecureAuth is set",
		(_label, opt) => {
			expect(
				() => new SmtpTransport({ host: "m", user: "u", pass: "p", ...opt }),
			).toThrow(expect.objectContaining({ code: "E_MAIL_PROVIDER_CONFIG" }));
			expect(
				() =>
					new SmtpTransport({
						host: "m",
						user: "u",
						pass: "p",
						allowInsecureAuth: true,
						...opt,
					}),
			).not.toThrow();
		},
	);
});
