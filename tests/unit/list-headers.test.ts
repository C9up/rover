import { afterEach, describe, expect, it } from "vitest";
import { listHeaders, Mail, MessageBuilder } from "../../src/index.js";
import { type FakeSmtp, startFakeSmtp } from "../__helpers__/fakeSmtp.js";

let server: FakeSmtp | undefined;

afterEach(async () => {
	await server?.close();
	server = undefined;
});

const invalid = expect.objectContaining({ code: "E_INVALID_LIST_HEADER" });

describe("rover > List-* values are checked and escaped", () => {
	it.each([
		[
			"a smuggled second URL",
			"https://app.example.com/u?id=1>, <https://evil.test/collect",
		],
		["whitespace", "https://app.example.com/u ?id=1"],
		["an angle bracket", "<https://app.example.com/u>"],
		["a line break", "https://app.example.com/u\r\nBcc: evil@attacker.test"],
		["an unknown scheme", "javascript:alert(1)"],
		["no scheme at all", "app.example.com/u"],
	])("refuses a URL with %s", (_label, url) => {
		expect(() => new MessageBuilder().listHelp(url)).toThrow(invalid);
		expect(() =>
			new MessageBuilder().listHelp({ url, comment: "help" }),
		).toThrow(invalid);
	});

	it.each([
		["http:", "http://plain-http.example.com/u"],
		["an http-prefixed scheme", "httpfoo:x"],
		["mailto:", "mailto:unsub@example.com"],
	])("oneClick refuses %s: RFC 8058 requires https", (_label, url) => {
		expect(() =>
			new MessageBuilder().listUnsubscribe(url, { oneClick: true }),
		).toThrow(invalid);
	});

	it("refuses a line break in a comment", () => {
		expect(() =>
			new MessageBuilder().listHelp({
				url: "https://x.test/h",
				comment: "a\r\nBcc: evil@attacker.test",
			}),
		).toThrow(invalid);
	});

	it("escapes the comment so it cannot close and open a URL", async () => {
		const built = await new MessageBuilder()
			.listHelp({
				url: "https://x.test/h",
				comment: "c) <https://evil.test/> (",
			})
			.build();
		expect(listHeaders(built)["List-Help"]).toBe(
			"<https://x.test/h> (c\\) <https://evil.test/> \\()",
		);
	});

	it("encodes a non-ASCII comment alone, never the URL", async () => {
		const built = await new MessageBuilder()
			.listHelp({ url: "https://x.test/h", comment: "Aide é" })
			.build();
		expect(listHeaders(built)["List-Help"]).toBe(
			"<https://x.test/h> (=?UTF-8?B?QWlkZSDDqQ==?=)",
		);
	});

	it("turns a bare address into a mailto: URL", async () => {
		const built = await new MessageBuilder().listHelp("help@x.test").build();
		expect(listHeaders(built)["List-Help"]).toBe("<mailto:help@x.test>");
	});

	it("over SMTP, each List-* header appears once, escaped by nodemailer", async () => {
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
				.subject("s")
				.text("x")
				.listUnsubscribe("https://app.example.com/u?id=1", { oneClick: true })
				.listHelp({ url: "https://x.test/h", comment: "c) (" }),
		);
		const data = server.sessions[0]?.data[0] ?? "";
		expect(data.match(/^List-Unsubscribe:/gim)).toHaveLength(1);
		expect(data).toMatch(
			/^List-Unsubscribe: <https:\/\/app\.example\.com\/u\?id=1>\r$/m,
		);
		expect(data).toMatch(
			/^List-Unsubscribe-Post: List-Unsubscribe=One-Click\r$/m,
		);
		expect(data).toMatch(
			/^List-Help: <https:\/\/x\.test\/h> \(c\\\) \\\(\)\r$/m,
		);
	});
});
