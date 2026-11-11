import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Mail, type MailMessage, MessageBuilder } from "../../src/index.js";
import { composeMime } from "../../src/mime.js";
import { MailJobHandler } from "../../src/queue/MailJob.js";
import { bypassTypeCheck } from "../__helpers__/bypass-type-check.js";

const secretDir = mkdtempSync(join(tmpdir(), "rover-compiled-"));
const secret = join(secretDir, "secret.txt");
writeFileSync(secret, "SECRET-CONTENT-42\n");

/** What `JSON.parse` of a queue payload yields: plain objects, nothing typed. */
function payload(extra: Record<string, unknown>): MailMessage {
	const parsed: unknown = JSON.parse(
		JSON.stringify({
			from: "a@example.com",
			to: ["b@example.com"],
			cc: [],
			bcc: [],
			subject: "probe",
			text: "hello",
			attachments: [],
			headers: {},
			...extra,
		}),
	);
	// A message the type system never saw, handed over the way a queue
	// driver hands it: as whatever the JSON held.
	return bypassTypeCheck<MailMessage>(parsed);
}

const hostile: Array<[string, MailMessage]> = [
	["icalEvent.path", payload({ icalEvent: { path: secret } })],
	[
		"icalEvent.path next to content",
		payload({ icalEvent: { path: secret, content: "BEGIN:VCALENDAR" } }),
	],
	[
		"icalEvent.href",
		payload({
			icalEvent: { href: "http://169.254.169.254/latest/meta-data/" },
		}),
	],
	[
		"icalEvent content object",
		payload({ icalEvent: { content: { path: secret } } }),
	],
	[
		"attachment content object",
		payload({
			attachments: [{ filename: "x.txt", content: { path: secret } }],
		}),
	],
	[
		"attachment content href",
		payload({
			attachments: [{ filename: "x", content: { href: "http://10.0.0.1/" } }],
		}),
	],
];

function logMail(): Mail {
	return new Mail({
		default: "log",
		from: "a@example.com",
		mailers: { log: { transport: "log" } },
	});
}

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	fetchSpy = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(
			async () =>
				new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR", { status: 200 }),
		);
});
afterEach(() => fetchSpy.mockRestore());

describe("rover > a compiled message cannot make the worker read a file or a URL", () => {
	it.each(hostile)("sendCompiled refuses %s", async (_label, message) => {
		await expect(logMail().sendCompiled(message)).rejects.toMatchObject({
			code: "E_MAIL_INVALID_MESSAGE",
		});
	});

	it.each(hostile)("a queued job refuses %s", async (_label, message) => {
		const handler = new MailJobHandler(logMail());
		await expect(handler.handle({ message })).rejects.toMatchObject({
			code: "E_MAIL_INVALID_MESSAGE",
		});
	});

	it.each(hostile)(
		"the MIME transports refuse %s even when called directly",
		async (_label, message) => {
			await expect(composeMime(message)).rejects.toMatchObject({
				code: "E_MAIL_INVALID_MESSAGE",
			});
		},
	);

	it("composes the invitation's content and options", async () => {
		const { raw } = await composeMime(
			payload({
				icalEvent: {
					content: "BEGIN:VCALENDAR\nEND:VCALENDAR",
					method: "REQUEST",
					filename: "meeting.ics",
				},
			}),
		);
		const mime = raw.toString("utf8");
		expect(mime).toContain("BEGIN:VCALENDAR");
		expect(mime).toMatch(/method=REQUEST/);
		expect(mime).toContain("meeting.ics");
		expect(mime).not.toContain("SECRET-CONTENT-42");
	});

	it("refuses a line break in a compiled attachment or threading header", async () => {
		await expect(
			logMail().sendCompiled(
				payload({
					attachments: [
						{
							filename: "x",
							content: "x",
							headers: { "X-A": "1\r\nBcc: e@x" },
						},
					],
				}),
			),
		).rejects.toMatchObject({ code: "E_MAIL_HEADER_INJECTION" });
		await expect(
			logMail().sendCompiled(
				payload({
					attachments: [{ filename: "x", content: "x", cid: "a\r\nX: y" }],
				}),
			),
		).rejects.toMatchObject({ code: "E_MAIL_HEADER_INJECTION" });
		await expect(
			logMail().sendCompiled(payload({ inReplyTo: "<a@b>\r\nBcc: e@x" })),
		).rejects.toMatchObject({ code: "E_MAIL_HEADER_INJECTION" });
	});

	it("still sends a well-formed compiled invitation and attachment", async () => {
		const response = await logMail().sendCompiled(
			payload({
				icalEvent: { content: "BEGIN:VCALENDAR", method: "REQUEST" },
				attachments: [{ filename: "a.txt", content: "bytes" }],
			}),
		);
		expect(response.envelope.to).toEqual(["b@example.com"]);
	});
});

describe("rover > a built invitation is its bytes", () => {
	const builder = () =>
		new MessageBuilder().from("a@example.com").to("b@example.com").subject("s");

	it("reads icalEventFromFile at build time and keeps no path", async () => {
		const ics = join(secretDir, "e.ics");
		writeFileSync(ics, "BEGIN:VCALENDAR\r\nEND:VCALENDAR");
		const built = await builder().icalEventFromFile(ics).build();
		expect(built.icalEvent).toEqual({
			content: "BEGIN:VCALENDAR\r\nEND:VCALENDAR",
		});
	});

	it("fetches icalEventFromUrl at build time and keeps no URL", async () => {
		const built = await builder()
			.icalEventFromUrl("https://calendar.example.com/e.ics", {
				method: "REQUEST",
			})
			.build();
		expect(fetchSpy).toHaveBeenCalledWith(
			"https://calendar.example.com/e.ics",
			expect.anything(),
		);
		expect(built.icalEvent).toEqual({
			method: "REQUEST",
			content: "BEGIN:VCALENDAR\r\nEND:VCALENDAR",
		});
	});

	it("refuses an icalEventFromUrl that is not http(s)", async () => {
		await expect(
			builder().icalEventFromUrl(`file://${secret}`).build(),
		).rejects.toMatchObject({ code: "E_ATTACHMENT_UNREADABLE" });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("refuses an icalEventFromUrl the server does not serve", async () => {
		fetchSpy.mockImplementation(
			async () => new Response("no", { status: 404 }),
		);
		await expect(
			builder().icalEventFromUrl("https://calendar.example.com/e.ics").build(),
		).rejects.toMatchObject({ code: "E_ATTACHMENT_UNREADABLE" });
	});
});
