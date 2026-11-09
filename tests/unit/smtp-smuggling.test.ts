import { afterEach, describe, expect, it } from "vitest";
import { Mail, type MessageBuilder } from "../../src/index.js";
import { type FakeSmtp, startFakeSmtp } from "../__helpers__/fakeSmtp.js";

let server: FakeSmtp | undefined;

afterEach(async () => {
	await server?.close();
	server = undefined;
});

async function dataOf(build: (m: MessageBuilder) => void): Promise<string> {
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
	await mail.send((m) => {
		m.to("bob@example.com").subject("s");
		build(m);
	});
	return server.sessions.flatMap((s) => s.data).join("");
}

/** Every CR is followed by LF and every LF preceded by CR (RFC 5321 §2.3.8). */
function expectCanonicalLineEndings(data: string): void {
	expect(data).not.toMatch(/\r(?!\n)/);
	expect(data).not.toMatch(/(?<!\r)\n/);
}

const payloads = [
	"a\r.\rMAIL FROM:<x@y>\rb",
	"a\r.\r\nMAIL FROM:<x@y>\r\nb",
	"a\n.\rMAIL",
	"mixed\rcr\nlf\r\ncrlf",
];

describe("rover > no bare CR or LF reaches the SMTP DATA stream", () => {
	it.each(payloads)("text body %j", async (payload) => {
		expectCanonicalLineEndings(await dataOf((m) => m.text(payload)));
	});

	it.each(payloads)("html body %j", async (payload) => {
		expectCanonicalLineEndings(await dataOf((m) => m.html(payload)));
	});

	it.each(payloads)("watch body %j", async (payload) => {
		expectCanonicalLineEndings(
			await dataOf((m) => m.text("t").watchHtml(payload)),
		);
	});

	it("a string attachment", async () => {
		expectCanonicalLineEndings(
			await dataOf((m) =>
				m.text("t").attachData("a\r.\rMAIL FROM:<x@y>\r", {
					filename: "note.txt",
					contentType: "text/plain",
				}),
			),
		);
	});

	it("a calendar invitation", async () => {
		expectCanonicalLineEndings(
			await dataOf((m) =>
				m
					.text("t")
					.icalEvent("BEGIN:VCALENDAR\r.\rMAIL FROM:<x@y>\rEND:VCALENDAR"),
			),
		);
	});

	it("keeps the text itself, with CRLF line ends", async () => {
		const data = await dataOf((m) => m.text("line one\rline two\nline three"));
		expect(data).toContain("line one\r\nline two\r\nline three");
	});
});
