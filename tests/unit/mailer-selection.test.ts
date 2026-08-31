/**
 * `{ default, mailers }` — how a config declares several ways of sending and
 * names the one used when `send()` is called without one.
 */
import { describe, expect, it } from "vitest";
import {
	Mail,
	type MailMessage,
	type MailTransport,
	type RoverError,
	registerTransport,
	transports,
} from "../../src/index.js";

class SpyTransport implements MailTransport {
	sent: MailMessage[] = [];
	async send(message: MailMessage): Promise<void> {
		this.sent.push(message);
	}
}

const deliver = (mail: Mail, mailer?: string) =>
	mail.send((message) => {
		message.to("user@example.com").subject("Hi").text("body");
	}, mailer);

describe("rover > mailer selection", () => {
	it("sends through the mailer `default` names", async () => {
		const primary = new SpyTransport();
		const secondary = new SpyTransport();
		registerTransport("spy-selection-primary", () => primary);
		registerTransport("spy-selection-secondary", () => secondary);

		const mail = new Mail({
			default: "secondary",
			from: "noreply@example.com",
			mailers: {
				primary: { transport: "spy-selection-primary" },
				secondary: { transport: "spy-selection-secondary" },
			},
		});

		await deliver(mail);

		expect(secondary.sent).toHaveLength(1);
		expect(primary.sent).toHaveLength(0);
	});

	it("routes `send(cb, name)` and `use(name)` to the named mailer", async () => {
		const primary = new SpyTransport();
		const secondary = new SpyTransport();
		registerTransport("spy-route-primary", () => primary);
		registerTransport("spy-route-secondary", () => secondary);

		const mail = new Mail({
			default: "primary",
			from: "noreply@example.com",
			mailers: {
				primary: { transport: "spy-route-primary" },
				secondary: { transport: "spy-route-secondary" },
			},
		});

		await deliver(mail, "secondary");
		await mail.use("secondary").send((message) => {
			message.to("user@example.com").subject("Hi").text("body");
		});

		expect(secondary.sent).toHaveLength(2);
		expect(primary.sent).toHaveLength(0);
	});

	it("reads the same map under the older `transports` spelling", async () => {
		const spy = new SpyTransport();
		registerTransport("spy-older-spelling", () => spy);

		const mail = new Mail({
			default: "smtp",
			from: "noreply@example.com",
			transports: { smtp: { transport: "spy-older-spelling" } },
		});

		await deliver(mail);

		expect(spy.sent).toHaveLength(1);
	});

	it("prefers `mailers` on a name both spellings declare", async () => {
		const older = new SpyTransport();
		const current = new SpyTransport();
		registerTransport("spy-shared-older", () => older);
		registerTransport("spy-shared-current", () => current);

		// Not a shape to write on purpose — but a half-migrated config must land
		// on one answer, not on whichever key the runtime happened to read last.
		const mail = new Mail({
			default: "smtp",
			from: "noreply@example.com",
			transports: { smtp: { transport: "spy-shared-older" } },
			mailers: { smtp: { transport: "spy-shared-current" } },
		});

		await deliver(mail);

		expect(current.sent).toHaveLength(1);
		expect(older.sent).toHaveLength(0);
	});

	it("refuses a config that declares no mailer at all", () => {
		try {
			new Mail({ default: "smtp", from: "noreply@example.com", mailers: {} });
			expect.unreachable("an empty `mailers` map has to be refused");
		} catch (error) {
			expect((error as RoverError).code).toBe("E_MAIL_UNKNOWN_MAILER");
			expect((error as RoverError).hint).toMatch(/No mailers are declared/);
		}
	});

	it("builds the descriptor each helper names", () => {
		expect(transports.smtp({ host: "smtp.example.com" })).toEqual({
			transport: "smtp",
			host: "smtp.example.com",
		});
		expect(transports.log()).toEqual({ transport: "log" });
		expect(transports.ses({ region: "eu-west-1" })).toEqual({
			transport: "ses",
			region: "eu-west-1",
		});
	});
});
