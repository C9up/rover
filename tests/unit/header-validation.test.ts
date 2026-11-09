import { afterEach, describe, expect, it } from "vitest";
import { Mail, MessageBuilder } from "../../src/index.js";
import { type FakeSmtp, startFakeSmtp } from "../__helpers__/fakeSmtp.js";

let server: FakeSmtp | undefined;

afterEach(async () => {
	await server?.close();
	server = undefined;
});

const injection = expect.objectContaining({ code: "E_MAIL_HEADER_INJECTION" });

describe("rover > every header entry point refuses line breaks and bad names", () => {
	it.each([
		["\r\n", "a\r\nBcc: evil@attacker.test"],
		["\n", "a\nBcc: evil@attacker.test"],
		["\r", "a\rBcc: evil@attacker.test"],
		["\\0", "a\0b"],
		["a blank line", "a\r\n\r\nforged body"],
	])("preparedHeader() value with %s", (_label, value) => {
		expect(() => new MessageBuilder().preparedHeader("X-Prep", value)).toThrow(
			injection,
		);
	});

	it.each([
		["a CRLF", "X-Evil\r\nBcc: evil@attacker.test\r\nX-Pad"],
		["a colon", "Bcc: evil@attacker.test\r\nX"],
		["a bare colon", "Bcc: evil"],
		["a trailing space", "Content-Type "],
		["a tab", "From\t"],
		["a space inside", "X Evil"],
		["nothing", ""],
		["non-ASCII", "X-Ünïcode"],
	])("header() name with %s", (_label, name) => {
		expect(() => new MessageBuilder().header(name, "v")).toThrow(injection);
		expect(() => new MessageBuilder().preparedHeader(name, "v")).toThrow(
			injection,
		);
	});

	it("header() values, single or listed", () => {
		expect(() => new MessageBuilder().header("X-A", "a\r\nb")).toThrow(
			injection,
		);
		expect(() => new MessageBuilder().header("X-A", ["ok", "a\nb"])).toThrow(
			injection,
		);
	});

	it("addListHeader() key", () => {
		expect(() =>
			new MessageBuilder().addListHeader(
				"help\r\nBcc: evil@attacker.test",
				"https://x.test/h",
			),
		).toThrow(injection);
	});

	it("a message that skipped the builder is checked at dispatch", async () => {
		const mail = new Mail({
			default: "log",
			from: "app@example.com",
			mailers: { log: { transport: "log" } },
		});
		await expect(
			mail.sendCompiled({
				from: "app@example.com",
				to: ["a@example.com"],
				cc: [],
				bcc: [],
				subject: "s",
				attachments: [],
				headers: { "X-Prep": { prepared: true, value: "a\r\nBcc: e@x.test" } },
			}),
		).rejects.toMatchObject({ code: "E_MAIL_HEADER_INJECTION" });
	});

	it("legitimate headers still reach the wire, prepared ones untouched", async () => {
		server = await startFakeSmtp();
		const mail = new Mail({
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
		});
		await mail.send((m) =>
			m
				.to("bob@example.com")
				.header("X-Campaign", "summer")
				.preparedHeader("X-Signed", "=?utf-8?q?pre-encoded?=")
				.subject("s")
				.text("x"),
		);
		const data = server.sessions[0]?.data[0] ?? "";
		expect(data).toMatch(/^X-Campaign: summer\r$/m);
		expect(data).toMatch(/^X-Signed: =\?utf-8\?q\?pre-encoded\?=\r$/m);
	});
});
