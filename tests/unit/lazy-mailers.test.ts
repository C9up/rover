import { describe, expect, it } from "vitest";
import {
	Mail,
	type MailTransport,
	registerTransport,
} from "../../src/index.js";

describe("rover > mailers are built on first use, then cached (AdonisJS MailManager.use)", () => {
	it("an unused smtp mailer with an empty host does not stop the boot", () => {
		// What `ream configure @c9up/rover` generates: SMTP_HOST="" in .env.
		expect(
			() =>
				new Mail({
					default: "log",
					from: "app@example.com",
					mailers: {
						log: { transport: "log" },
						smtp: { transport: "smtp", host: "", port: "587" },
					},
				}),
		).not.toThrow();
	});

	it("the misconfigured mailer still reports its config error when first used", async () => {
		const mail = new Mail({
			default: "log",
			from: "app@example.com",
			mailers: {
				log: { transport: "log" },
				smtp: { transport: "smtp", host: "" },
			},
		});
		expect(() => mail.use("smtp")).toThrow(/SMTP host is required/);
		await expect(
			mail.send((m) => m.to("a@example.com").subject("s").text("x"), "smtp"),
		).rejects.toThrow(/SMTP host is required/);
	});

	it("builds a transport once, on first use, and reuses it", async () => {
		let built = 0;
		registerTransport("lazy-counter", () => {
			built += 1;
			const transport: MailTransport = { send: async () => undefined };
			return transport;
		});
		const mail = new Mail({
			default: "counted",
			from: "app@example.com",
			mailers: { counted: { transport: "lazy-counter" } },
		});
		expect(built).toBe(0);
		await mail.send((m) => m.to("a@example.com").subject("s").text("x"));
		await mail.send((m) => m.to("b@example.com").subject("s").text("x"));
		expect(mail.use("counted").transport).toBe(mail.use("counted").transport);
		expect(built).toBe(1);
	});

	it("close() drops a closed transport so the next use builds a fresh one", async () => {
		let built = 0;
		let closed = 0;
		registerTransport("lazy-closable", () => {
			built += 1;
			const transport: MailTransport = {
				send: async () => undefined,
				close: async () => {
					closed += 1;
				},
			};
			return transport;
		});
		const mail = new Mail({
			default: "c",
			from: "app@example.com",
			mailers: {
				c: { transport: "lazy-closable" },
				unused: { transport: "lazy-closable" },
			},
		});
		await mail.send((m) => m.to("a@example.com").subject("s").text("x"));
		await mail.closeAll();
		// closeAll() closes what was built, and does not build the unused one.
		expect([built, closed]).toEqual([1, 1]);
		await mail.send((m) => m.to("a@example.com").subject("s").text("x"));
		expect(built).toBe(2);
	});

	it.each(["constructor", "toString", "hasOwnProperty", "__proto__"])(
		"refuses the inherited name %s as a transport type at construction",
		(transport) => {
			expect(
				() =>
					new Mail({
						default: "x",
						from: "app@example.com",
						mailers: { x: { transport } },
					}),
			).toThrow(expect.objectContaining({ code: "E_MAIL_UNKNOWN_TRANSPORT" }));
		},
	);

	it("still refuses an unknown transport type and an undeclared default at construction", () => {
		expect(
			() =>
				new Mail({
					default: "x",
					from: "app@example.com",
					mailers: { x: { transport: "no-such-transport" } },
				}),
		).toThrow(expect.objectContaining({ code: "E_MAIL_UNKNOWN_TRANSPORT" }));
		expect(
			() =>
				new Mail({
					default: "missing",
					from: "app@example.com",
					mailers: { log: { transport: "log" } },
				}),
		).toThrow(expect.objectContaining({ code: "E_MAIL_UNKNOWN_MAILER" }));
	});
});
