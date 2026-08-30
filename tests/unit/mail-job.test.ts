/**
 * The Bay job handler for queued mail.
 *
 * It sits on the far side of a serialisation boundary: whatever the queue
 * driver hands back has been through JSON, and may have been written by an
 * older deploy. So the two things worth proving are that a malformed payload
 * fails cleanly instead of crashing inside the transport, and that a Buffer
 * attachment survives the round trip as bytes rather than as an object.
 */
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type { MailMessage } from "../../src/index.js";
import {
	type MailDispatcher,
	MailJobHandler,
} from "../../src/queue/MailJob.js";

class RecordingDispatcher implements MailDispatcher {
	calls: Array<{
		message: MailMessage;
		transport?: string;
		retry?: { maxAttempts: number };
	}> = [];
	async dispatchMessage(
		message: MailMessage,
		transport?: string,
		overrideRetry?: {
			maxAttempts: number;
			baseDelayMs: number;
			factor: number;
		},
	): Promise<void> {
		this.calls.push({ message, transport, retry: overrideRetry });
	}
}

const payload = (over: Partial<MailMessage> = {}) => ({
	message: {
		from: "a@acme.test",
		to: ["b@acme.test"],
		cc: [],
		bcc: [],
		subject: "S",
		attachments: [],
		headers: {},
		...over,
	},
});

describe("rover > MailJobHandler", () => {
	it("dispatches the message it was handed, on the named transport", async () => {
		const dispatcher = new RecordingDispatcher();

		await new MailJobHandler(dispatcher).handle({
			...payload(),
			transport: "ses",
		});

		expect(dispatcher.calls).toHaveLength(1);
		expect(dispatcher.calls[0].message.subject).toBe("S");
		expect(dispatcher.calls[0].transport).toBe("ses");
	});

	it("runs the in-process retry loop exactly once", async () => {
		const dispatcher = new RecordingDispatcher();

		await new MailJobHandler(dispatcher).handle(payload());

		// Bay re-dispatches on throw. If the handler also retried, one queue
		// job would become maxAttempts × maxAttempts sends.
		expect(dispatcher.calls[0].retry?.maxAttempts).toBe(1);
	});

	it("leaves the transport unset when the payload named none", async () => {
		const dispatcher = new RecordingDispatcher();

		await new MailJobHandler(dispatcher).handle({
			...payload(),
			transport: 42,
		});

		// A non-string transport is not a transport name — falling back to the
		// default beats sending through `"42"`.
		expect(dispatcher.calls[0].transport).toBeUndefined();
	});

	it("rebuilds a Buffer attachment that JSON flattened into an object", async () => {
		const dispatcher = new RecordingDispatcher();
		const bytes = Buffer.from("%PDF-1.4");
		// This is precisely what `JSON.parse(JSON.stringify(buffer))` produces.
		const serialised = JSON.parse(JSON.stringify(bytes));

		await new MailJobHandler(dispatcher).handle(
			payload({
				attachments: [{ filename: "report.pdf", content: serialised }],
			}),
		);

		const content = dispatcher.calls[0].message.attachments[0].content;
		expect(Buffer.isBuffer(content)).toBe(true);
		expect((content as Buffer).toString()).toBe("%PDF-1.4");
	});

	it("leaves an attachment alone when it is already bytes or text", async () => {
		const dispatcher = new RecordingDispatcher();

		await new MailJobHandler(dispatcher).handle(
			payload({
				attachments: [
					{ filename: "a.txt", content: "plain" },
					{ filename: "b.bin", content: Buffer.from("raw") },
					{ filename: "c.bin", content: { type: "NotABuffer" } },
				],
			}),
		);

		const [a, b, c] = dispatcher.calls[0].message.attachments;
		expect(a.content).toBe("plain");
		expect(Buffer.isBuffer(b.content)).toBe(true);
		expect(c.content).toEqual({ type: "NotABuffer" });
	});

	it("takes a message with no attachments at all", async () => {
		const dispatcher = new RecordingDispatcher();

		await new MailJobHandler(dispatcher).handle(payload());

		expect(dispatcher.calls[0].message.attachments).toEqual([]);
	});

	it("refuses a payload that is not an object", async () => {
		const handler = new MailJobHandler(new RecordingDispatcher());

		for (const bad of [null, undefined, "a string", 7]) {
			await expect(handler.handle(bad)).rejects.toThrow(
				/missing or not an object/,
			);
		}
	});

	it("refuses a payload with no message", async () => {
		const handler = new MailJobHandler(new RecordingDispatcher());

		await expect(handler.handle({ transport: "ses" })).rejects.toThrow(
			/payload\.message is missing/,
		);
		await expect(handler.handle({ message: "not one" })).rejects.toThrow(
			/payload\.message is missing/,
		);
	});

	it("refuses a message that is not shaped like one", async () => {
		const handler = new MailJobHandler(new RecordingDispatcher());

		// An older deploy's payload, or a corrupted queue entry: better a named
		// failure Bay can record than a TypeError from inside the transport.
		for (const message of [
			{ to: ["b@acme.test"], attachments: [] },
			{ from: "a@acme.test", attachments: [] },
			{ from: "a@acme.test", to: ["b@acme.test"] },
		]) {
			await expect(handler.handle({ message })).rejects.toThrow(
				/does not match MailMessage shape/,
			);
		}
	});

	it("names its failures, so the queue records a code rather than a stack", async () => {
		const handler = new MailJobHandler(new RecordingDispatcher());

		await expect(handler.handle(null)).rejects.toMatchObject({
			code: "MAIL_JOB_MALFORMED",
		});
	});
});
