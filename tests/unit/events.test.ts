import { ReamError } from "@c9up/ream";
import { describe, expect, it } from "vitest";
import {
	type EmitterLike,
	Mail,
	type MailMessage,
	type MailSendResult,
	type MailTransport,
	registerTransport,
} from "../../src/index.js";

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

const providerError = (status: number): ReamError =>
	new ReamError("MAIL_PROVIDER_ERROR", `provider returned ${status}`, {
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

		expect(emitter.events).toHaveLength(1);
		expect(emitter.events[0].name).toBe("mail.sent");
		const data = emitter.events[0].data as {
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

		const data = emitter.events[0].data as { messageId: string };
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

		const failed = emitter.events.filter((e) => e.name === "mail.failed");
		const sent = emitter.events.filter((e) => e.name === "mail.sent");
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
		).rejects.toBeInstanceOf(ReamError);

		const failed = emitter.events.find((e) => e.name === "mail.failed");
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
