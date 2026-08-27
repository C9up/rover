import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	type EmitterLike,
	Mail,
	type MailMessage,
	type MailSendResult,
	type MailTransport,
	registerTransport,
} from "../../src/index.js";
import { RoverError } from "../../src/RoverError.js";

class PassTransport implements MailTransport {
	async send(_m: MailMessage): Promise<void> {}
}

class ProviderIdTransport implements MailTransport {
	constructor(private id: string) {}
	async send(_m: MailMessage): Promise<MailSendResult> {
		return { providerId: this.id };
	}
}

class ScriptedTransport implements MailTransport {
	calls = 0;
	constructor(private behaviour: Array<"ok" | Error>) {}
	async send(_m: MailMessage): Promise<void> {
		const step =
			this.behaviour[this.calls] ?? this.behaviour[this.behaviour.length - 1];
		this.calls += 1;
		if (step === "ok") return;
		throw step;
	}
}

class SpyEmitter implements EmitterLike {
	events: Array<{ name: string; data: unknown }> = [];
	emit(name: string, data: unknown): void {
		this.events.push({ name, data });
	}
}

const providerError = (status: number): RoverError =>
	new RoverError("MAIL_PROVIDER_ERROR", `provider returned ${status}`, {
		context: {
			provider: "test",
			upstreamStatus: String(status),
			providerMessage: "mocked",
		},
	});

const makeMail = (
	transportName: string,
	transport: MailTransport,
	emitter?: EmitterLike,
): Mail => {
	registerTransport(transportName, () => transport);
	return new Mail(
		{
			default: "log",
			from: "default@example.com",
			transports: {
				log: { transport: transportName },
			},
			retry: { maxAttempts: 1, baseDelayMs: 10, factor: 1 },
		},
		{ emitter },
	);
};

describe("rover > delivery events", () => {
	it("fires mail.sent after a successful send with the expected payload shape", async () => {
		const emitter = new SpyEmitter();
		const mail = makeMail("tail-evt-1", new PassTransport(), emitter);

		await mail.send((m) => m.to("u@x.com").subject("Hi"));

		// mail:sending fires before mail:sent (AdonisJS event contract).
		expect(emitter.events[0].name).toBe("mail:sending");
		const sent = emitter.events.filter((e) => e.name === "mail:sent");
		expect(sent).toHaveLength(1);
		const data = sent[0].data as {
			messageId: string;
			to: string[];
			transportName: string;
			timestamp: number;
		};
		expect(data.to).toEqual(["u@x.com"]);
		expect(data.transportName).toBe("log");
		expect(typeof data.messageId).toBe("string");
		expect(data.messageId).toMatch(/^[0-9a-f]{32}$/);
		expect(typeof data.timestamp).toBe("number");
	});

	it("surfaces the transport's providerId in the mail.sent messageId", async () => {
		const emitter = new SpyEmitter();
		const mail = makeMail(
			"tail-evt-2",
			new ProviderIdTransport("mg-abc"),
			emitter,
		);

		await mail.send((m) => m.to("u@x.com").subject("Hi"));

		const sent = emitter.events.find((e) => e.name === "mail:sent");
		const data = sent?.data as { messageId: string };
		expect(data.messageId).toBe("mg-abc");
	});

	it("fires mail.failed only on exhausted retries, not on intermediate transients", async () => {
		const emitter = new SpyEmitter();
		const transport = new ScriptedTransport([providerError(502), "ok"]);
		registerTransport("tail-evt-3", () => transport);

		const mail = new Mail(
			{
				default: "log",
				from: "default@example.com",
				transports: { log: { transport: "tail-evt-3" } },
				retry: { maxAttempts: 3, baseDelayMs: 5, factor: 1 },
			},
			{ emitter },
		);
		await mail.send((m) => m.to("u@x.com").subject("Hi"));

		const failed = emitter.events.filter((e) => e.name === "mail:failed");
		const sent = emitter.events.filter((e) => e.name === "mail:sent");
		expect(failed).toHaveLength(0);
		expect(sent).toHaveLength(1);
	});

	it("fires mail.failed with upstreamStatus + attempts on exhaustion", async () => {
		const emitter = new SpyEmitter();
		const transport = new ScriptedTransport([
			providerError(503),
			providerError(503),
		]);
		registerTransport("tail-evt-4", () => transport);
		const mail = new Mail(
			{
				default: "log",
				from: "default@example.com",
				transports: { log: { transport: "tail-evt-4" } },
				retry: { maxAttempts: 2, baseDelayMs: 5, factor: 1 },
			},
			{ emitter },
		);

		await expect(
			mail.send((m) => m.to("u@x.com").subject("Hi")),
		).rejects.toBeInstanceOf(RoverError);

		const failed = emitter.events.find((e) => e.name === "mail:failed");
		expect(failed).toBeDefined();
		const data = failed?.data as {
			error: { code: string; upstreamStatus?: number; attempts: number };
			to: string[];
		};
		expect(data.error.code).toBe("MAIL_PROVIDER_ERROR");
		expect(data.error.upstreamStatus).toBe(503);
		expect(data.error.attempts).toBe(2);
		expect(data.to).toEqual(["u@x.com"]);
	});

	it("works without an emitter — send succeeds, no crash", async () => {
		const mail = makeMail("tail-evt-5", new PassTransport());
		await expect(
			mail.send((m) => m.to("u@x.com").subject("Hi")),
		).resolves.toBeUndefined();
	});

	it("swallows errors thrown by the emitter (event bus failure ≠ send failure)", async () => {
		const emitter: EmitterLike = {
			emit() {
				throw new Error("bus down");
			},
		};
		const mail = makeMail("tail-evt-6", new PassTransport(), emitter);

		await expect(
			mail.send((m) => m.to("u@x.com").subject("Hi")),
		).resolves.toBeUndefined();
	});
});

describe("rover > mail events carry the AdonisJS triple", () => {
	it("names the mailer and carries the message itself", async () => {
		const emitter = new SpyEmitter();
		const mail = makeMail("triple-1", new PassTransport(), emitter);

		await mail.send((m) => m.to("a@b.c").subject("Hi").html("<p>hi</p>"));

		const sent = emitter.events.find((e) => e.name === "mail:sent")?.data as
			| Record<string, unknown>
			| undefined;
		// A listener migrated from @adonisjs/mail reads `message` and
		// `mailerName`; both used to be absent, leaving it with undefined.
		expect(sent?.mailerName).toBe("log");
		expect((sent?.message as { subject?: string }).subject).toBe("Hi");
		// rover's own name for the same string stays, so existing listeners keep
		// working.
		expect(sent?.transportName).toBe("log");
	});

	it("reports an empty views bag for a message built without a template", async () => {
		const emitter = new SpyEmitter();
		const mail = makeMail("triple-2", new PassTransport(), emitter);

		await mail.send((m) => m.to("a@b.c").subject("Hi").html("<p>hi</p>"));

		const sending = emitter.events.find((e) => e.name === "mail:sending")
			?.data as Record<string, unknown> | undefined;
		expect(sending?.views).toEqual({});
	});

	it("carries the same shape on the queue lifecycle", async () => {
		const emitter = new SpyEmitter();
		const mail = makeMail("triple-3", new PassTransport(), emitter);

		await mail.sendLater((m) =>
			m.to("a@b.c").subject("Later").html("<p>hi</p>"),
		);

		const queued = emitter.events.find((e) => e.name === "mail:queued")?.data as
			| Record<string, unknown>
			| undefined;
		expect(queued?.mailerName).toBe("log");
		expect((queued?.message as { subject?: string }).subject).toBe("Later");
	});

	it("names the template a message was rendered from", async () => {
		// A real views root: `build()` renders the template, and until now it
		// then cleared the pending view, so the template that produced the body
		// was gone by the time the event fired.
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "rover-views-"));
		fs.writeFileSync(path.join(root, "welcome.html"), "<p>{{ name }}</p>");

		const emitter = new SpyEmitter();
		registerTransport("triple-4", () => new PassTransport());
		const mail = new Mail(
			{
				default: "log",
				from: "default@example.com",
				viewsRoot: root,
				transports: { log: { transport: "triple-4" } },
				retry: { maxAttempts: 1, baseDelayMs: 10, factor: 1 },
			},
			{ emitter },
		);

		await mail.send((m) =>
			m.to("a@b.c").subject("Hi").htmlView("welcome", { name: "Ada" }),
		);

		const sent = emitter.events.find((e) => e.name === "mail:sent")?.data as
			| Record<string, unknown>
			| undefined;
		expect(sent?.views).toEqual({
			html: { template: "welcome", data: { name: "Ada" } },
		});
		fs.rmSync(root, { recursive: true, force: true });
	});
});

describe("rover > setMessenger wires a queue after construction", () => {
	/** The narrow shape rover asks of a queue — no @c9up/bay needed. */
	class FakeQueue {
		handlers = new Map<string, { handle(payload: unknown): Promise<void> }>();
		dispatched: Array<{ name: string; payload: unknown }> = [];

		register(
			name: string,
			handler: { handle(payload: unknown): Promise<void> },
		) {
			this.handlers.set(name, handler);
		}

		async dispatch(name: string, payload: unknown): Promise<string> {
			this.dispatched.push({ name, payload });
			return "job-1";
		}

		async drain(): Promise<void> {
			for (const { name, payload } of this.dispatched.splice(0)) {
				await this.handlers.get(name)?.handle(payload);
			}
		}
	}

	it("routes sendLater() through a queue handed over after construction", async () => {
		const transport = new PassTransport();
		const mail = makeMail("late-messenger", transport); // no queue at construction
		const queue = new FakeQueue();

		// A queue is often resolved later than the mailer — a provider that boots
		// after this one, a test that swaps it. The constructor was the only way
		// in, so a migrated `mail.setMessenger(queue)` stopped at a TypeError.
		expect(mail.setMessenger(queue)).toBe(mail);

		await mail.sendLater((m) =>
			m.to("a@b.c").subject("Later").html("<p>x</p>"),
		);

		expect(queue.dispatched).toHaveLength(1);
		await queue.drain();
	});

	it("registers the mail job handler on the queue it is given", () => {
		const mail = makeMail("late-messenger-2", new PassTransport());
		const queue = new FakeQueue();

		mail.setMessenger(queue);

		// Without the registration the dispatch above would enqueue a job
		// nothing knows how to run.
		expect(queue.handlers.size).toBe(1);
	});
});
