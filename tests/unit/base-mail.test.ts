import { describe, expect, it, vi } from "vitest";
import {
	BaseMail,
	Mail,
	type MailMessage,
	type MailTransport,
	registerTransport,
} from "../../src/index.js";
import { bypassTypeCheck } from "../__helpers__/bypass-type-check.js";

class SpyTransport implements MailTransport {
	sent: MailMessage[] = [];
	async send(message: MailMessage): Promise<void> {
		this.sent.push(message);
	}
}

class WelcomeMail extends BaseMail {
	constructor(
		private recipient: string,
		private displayName: string,
	) {
		super();
	}
	override prepare(): void {
		this.message
			.to(this.recipient)
			.subject(`Welcome ${this.displayName}`)
			.html(`<p>Hello ${this.displayName}</p>`);
	}
}

class BrandedMail extends BaseMail {
	from = "orders@acme.com";
	subject = "Order shipped";
	override prepare(): void {
		this.message.to("user@example.com").text("on its way");
	}
}

class NamedSenderMail extends BaseMail {
	from = { address: "orders@acme.com", name: "Acme Orders" };
	override prepare(): void {
		this.message.to("user@example.com").subject("Order").text("body");
	}
}

class ExplicitFromInsidePrepareMail extends BaseMail {
	from = "instance@acme.com";
	override prepare(): void {
		this.message
			.from("custom@acme.com")
			.to("user@example.com")
			.subject("Custom sender")
			.text("body");
	}
}

class SubjectOverrideInsidePrepareMail extends BaseMail {
	subject = "Default subject";
	override prepare(): void {
		this.message.to("user@example.com").subject("Prepare wins").text("body");
	}
}

class AsyncPrepareMail extends BaseMail {
	fetched = false;
	override async prepare(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 5));
		this.fetched = true;
		this.message.to("async@example.com").subject("Async").text("ok");
	}
}

class SideEffectPrepareMail extends BaseMail {
	sideEffectCount = 0;
	override prepare(): void {
		this.sideEffectCount += 1;
		this.message.to("user@example.com").subject("X").text("y");
	}
}

describe("rover > BaseMail", () => {
	it("build() runs prepare() and yields the expected MailMessage shape", async () => {
		const mail = new WelcomeMail("user@example.com", "Ada");
		const msg = await mail.build();
		expect(msg.to).toEqual(["user@example.com"]);
		expect(msg.subject).toBe("Welcome Ada");
		expect(msg.html).toBe("<p>Hello Ada</p>");
	});

	it("Mail.send(instance) invokes prepare() before transport.send()", async () => {
		const spy = new SpyTransport();
		registerTransport("spy-base-mail-1", () => spy);
		const mail = new Mail({
			default: "spy",
			from: "default@example.com",
			transports: { spy: { transport: "spy-base-mail-1" } },
		});

		const instance = new WelcomeMail("user@example.com", "Lin");
		const prepareSpy = vi.spyOn(instance, "prepare");
		await mail.send(instance);

		expect(prepareSpy).toHaveBeenCalledOnce();
		expect(spy.sent).toHaveLength(1);
		expect(spy.sent[0].to).toEqual(["user@example.com"]);
		expect(spy.sent[0].subject).toBe("Welcome Lin");
		expect(spy.sent[0].from).toBe("default@example.com");
	});

	it("applies instance `from` (string) when set", async () => {
		const spy = new SpyTransport();
		registerTransport("spy-base-mail-2", () => spy);
		const mail = new Mail({
			default: "spy",
			from: "default@example.com",
			transports: { spy: { transport: "spy-base-mail-2" } },
		});

		await mail.send(new BrandedMail());
		expect(spy.sent[0].from).toBe("orders@acme.com");
		expect(spy.sent[0].subject).toBe("Order shipped");
	});

	it("applies instance `from` in { address, name } form as RFC 5322", async () => {
		const spy = new SpyTransport();
		registerTransport("spy-base-mail-3", () => spy);
		const mail = new Mail({
			default: "spy",
			from: "default@example.com",
			transports: { spy: { transport: "spy-base-mail-3" } },
		});

		await mail.send(new NamedSenderMail());
		expect(spy.sent[0].from).toBe('"Acme Orders" <orders@acme.com>');
	});

	it("falls back to config.from when instance `from` is unset", async () => {
		const spy = new SpyTransport();
		registerTransport("spy-base-mail-4", () => spy);
		const mail = new Mail({
			default: "spy",
			from: "default@example.com",
			transports: { spy: { transport: "spy-base-mail-4" } },
		});

		await mail.send(new WelcomeMail("user@example.com", "Kim"));
		expect(spy.sent[0].from).toBe("default@example.com");
	});

	it("explicit this.message.from() inside prepare wins over instance `from`", async () => {
		const spy = new SpyTransport();
		registerTransport("spy-base-mail-5", () => spy);
		const mail = new Mail({
			default: "spy",
			from: "default@example.com",
			transports: { spy: { transport: "spy-base-mail-5" } },
		});

		await mail.send(new ExplicitFromInsidePrepareMail());
		expect(spy.sent[0].from).toBe("custom@acme.com");
	});

	it("this.message.subject() inside prepare overrides instance `subject` shortcut", async () => {
		const spy = new SpyTransport();
		registerTransport("spy-base-mail-6", () => spy);
		const mail = new Mail({
			default: "spy",
			from: "default@example.com",
			transports: { spy: { transport: "spy-base-mail-6" } },
		});

		await mail.send(new SubjectOverrideInsidePrepareMail());
		expect(spy.sent[0].subject).toBe("Prepare wins");
	});

	it("awaits async prepare() before dispatch", async () => {
		const spy = new SpyTransport();
		registerTransport("spy-base-mail-7", () => spy);
		const mail = new Mail({
			default: "spy",
			from: "default@example.com",
			transports: { spy: { transport: "spy-base-mail-7" } },
		});

		const instance = new AsyncPrepareMail();
		await mail.send(instance);

		expect(instance.fetched).toBe(true);
		expect(spy.sent[0].subject).toBe("Async");
	});

	it("two instances of the same subclass have independent MessageBuilder state", async () => {
		const a = new WelcomeMail("a@example.com", "A");
		const b = new WelcomeMail("b@example.com", "B");
		const [msgA, msgB] = await Promise.all([a.build(), b.build()]);
		expect(msgA.to).toEqual(["a@example.com"]);
		expect(msgB.to).toEqual(["b@example.com"]);
		expect(msgA.subject).toBe("Welcome A");
		expect(msgB.subject).toBe("Welcome B");
	});

	it("callback overload remains backwards-compatible alongside instance overload", async () => {
		const spy = new SpyTransport();
		registerTransport("spy-base-mail-8", () => spy);
		const mail = new Mail({
			default: "spy",
			from: "default@example.com",
			transports: { spy: { transport: "spy-base-mail-8" } },
		});

		await mail.send((m) => {
			m.to("cb@example.com").subject("Callback").text("still works");
		});

		expect(spy.sent[0].to).toEqual(["cb@example.com"]);
		expect(spy.sent[0].from).toBe("default@example.com");
	});

	it("validates transport BEFORE running prepare() — no side-effect leak on misconfig", async () => {
		const mail = new Mail({
			default: "log",
			from: "default@example.com",
			transports: { log: { transport: "log" } },
		});

		const instance = new SideEffectPrepareMail();
		await expect(mail.send(instance, "bogus")).rejects.toThrow(
			/mailer 'bogus' is not declared/,
		);
		expect(instance.sideEffectCount).toBe(0);
	});

	it("throws when BaseMail is instantiated directly (runtime abstract guard)", () => {
		expect(() => {
			// @ts-expect-error -- deliberately bypassing the abstract-class check at runtime
			new BaseMail();
		}).toThrow("abstract");
	});

	it("does not mutate builder internal state when filling config.from fallback", async () => {
		const spy = new SpyTransport();
		registerTransport("spy-base-mail-9", () => spy);
		const mail = new Mail({
			default: "spy",
			from: "default@example.com",
			transports: { spy: { transport: "spy-base-mail-9" } },
		});

		const instance = new WelcomeMail("user@example.com", "Eve");
		await mail.send(instance);

		const rebuilt = await instance.build();
		expect(rebuilt.from).toBe("");
	});

	// 39.1-A2 — empty-from / empty-recipients guard at #buildMessage (deferred-work)
	it("rejects an instance that produces an empty `from` (no config default, no instance from)", async () => {
		const spy = new SpyTransport();
		registerTransport("spy-base-mail-validate-from", () => spy);
		const mail = new Mail({
			default: "spy",
			from: "",
			transports: { spy: { transport: "spy-base-mail-validate-from" } },
		});

		await expect(
			mail.send(new WelcomeMail("user@example.com", "NoFrom")),
		).rejects.toThrow(/no `from` address/);
		expect(spy.sent).toHaveLength(0);
	});

	it("rejects a callback that adds no recipients", async () => {
		const spy = new SpyTransport();
		registerTransport("spy-base-mail-validate-to", () => spy);
		const mail = new Mail({
			default: "spy",
			from: "default@example.com",
			transports: { spy: { transport: "spy-base-mail-validate-to" } },
		});

		await expect(
			mail.send((m) => {
				m.subject("No recipient").text("oops");
			}),
		).rejects.toThrow(/no recipients/);
		expect(spy.sent).toHaveLength(0);
	});

	// 39.1-A7 — error-path tests (deferred-work)
	it("propagates an error thrown inside prepare() to the Mail.send caller", async () => {
		const spy = new SpyTransport();
		registerTransport("spy-base-mail-prepare-throws", () => spy);
		const mail = new Mail({
			default: "spy",
			from: "default@example.com",
			transports: { spy: { transport: "spy-base-mail-prepare-throws" } },
		});

		class FailingPrepareMail extends BaseMail {
			override prepare(): void {
				throw new Error("prepare blew up");
			}
		}

		await expect(mail.send(new FailingPrepareMail())).rejects.toThrow(
			"prepare blew up",
		);
		expect(spy.sent).toHaveLength(0);
	});

	it("propagates a transport rejection unchanged when retries are disabled", async () => {
		class RejectingTransport implements MailTransport {
			async send(): Promise<void> {
				throw new Error("transport down");
			}
		}
		registerTransport(
			"spy-base-mail-transport-rejects",
			() => new RejectingTransport(),
		);
		const mail = new Mail({
			default: "spy",
			from: "default@example.com",
			transports: {
				spy: {
					transport: "spy-base-mail-transport-rejects",
					retry: { maxAttempts: 1 },
				},
			},
		});

		await expect(
			mail.send(new WelcomeMail("user@example.com", "Down")),
		).rejects.toThrow("transport down");
	});

	// 39.1-A6 — Mail constructor throws on unknown transport type (deferred-work)
	it("throws E_MAIL_UNKNOWN_TRANSPORT at construction when the transport type is not registered", () => {
		expect(
			() =>
				new Mail({
					default: "primary",
					from: "default@example.com",
					transports: {
						primary: { transport: "this-transport-does-not-exist" },
					},
				}),
		).toThrow(/Unknown mail transport type 'this-transport-does-not-exist'/);
	});

	// Tightened validateMailMessage: undefined `from`, whitespace-only,
	// and recipient arrays containing only empty strings are rejected.
	it("rejects an undefined `from` reaching the validator via type-laundering", async () => {
		const spy = new SpyTransport();
		registerTransport("spy-validate-from-undef", () => spy);
		// Simulates a config-loader returning {from: undefined} despite the
		// typed contract — the validator is the runtime safety net. The cast
		// is encapsulated in `bypassTypeCheck<T>` per DNR `feedback_no_any_types`.
		const mail = new Mail({
			default: "spy",
			from: bypassTypeCheck<string>(undefined),
			transports: { spy: { transport: "spy-validate-from-undef" } },
		});
		await expect(
			mail.send((m) => m.to("u@x.com").subject("Hi").text("hi")),
		).rejects.toThrow(/no `from` address/);
		expect(spy.sent).toHaveLength(0);
	});

	it("rejects a whitespace-only `from`", async () => {
		const spy = new SpyTransport();
		registerTransport("spy-validate-from-ws", () => spy);
		const mail = new Mail({
			default: "spy",
			from: "   ",
			transports: { spy: { transport: "spy-validate-from-ws" } },
		});
		await expect(mail.send(new WelcomeMail("u@x.com", "WS"))).rejects.toThrow(
			/no `from` address/,
		);
		expect(spy.sent).toHaveLength(0);
	});

	it("rejects recipient arrays that contain only empty strings", async () => {
		const spy = new SpyTransport();
		registerTransport("spy-validate-empty-to", () => spy);
		const mail = new Mail({
			default: "spy",
			from: "default@example.com",
			transports: { spy: { transport: "spy-validate-empty-to" } },
		});
		await expect(
			mail.send((m) => {
				m.to("");
				m.cc("   ");
				m.subject("nope").text("body");
			}),
		).rejects.toThrow(/no recipients/);
		expect(spy.sent).toHaveLength(0);
	});

	// dispatchMessage re-validates queue-deserialised payloads.
	it("dispatchMessage rejects a malformed MailMessage (defense-in-depth on queue dequeue)", async () => {
		const spy = new SpyTransport();
		registerTransport("spy-dispatch-validate", () => spy);
		const mail = new Mail({
			default: "spy",
			from: "default@example.com",
			transports: { spy: { transport: "spy-dispatch-validate" } },
		});
		// Simulate a queue payload that lost its recipients in transit.
		const malformed: MailMessage = {
			from: "default@example.com",
			to: [],
			cc: [],
			bcc: [],
			subject: "Lost recipients",
			text: "body",
			attachments: [],
			headers: {},
		};
		await expect(mail.dispatchMessage(malformed)).rejects.toThrow(
			/no recipients/,
		);
		expect(spy.sent).toHaveLength(0);
	});

	// MailJob.validatePayload only checks `m.to` is an array; cc/bcc are
	// optional at the queue boundary. A deserialised job payload may reach
	// dispatchMessage with `cc`/`bcc` as `undefined` — validateMailMessage
	// must surface `E_MAIL_INVALID_MESSAGE`, not crash on `.some(undefined)`.
	it("dispatchMessage surfaces E_MAIL_INVALID_MESSAGE when cc/bcc are missing (not TypeError)", async () => {
		const spy = new SpyTransport();
		registerTransport("spy-dispatch-undef", () => spy);
		const mail = new Mail({
			default: "spy",
			from: "default@example.com",
			transports: { spy: { transport: "spy-dispatch-undef" } },
		});
		const malformed = bypassTypeCheck<MailMessage>({
			from: "default@example.com",
			to: [],
			subject: "Missing cc/bcc fields",
			text: "body",
			attachments: [],
			headers: {},
		});
		await expect(mail.dispatchMessage(malformed)).rejects.toThrow(
			/no recipients/,
		);
		expect(spy.sent).toHaveLength(0);
	});
});

describe("rover > BaseMail builds once (AdonisJS `built` guard)", () => {
	class Welcome extends BaseMail {
		subject = "Hi";
		prepare() {
			this.message
				.to("a@b.c")
				.from("x@y.z")
				.attachData("body", { filename: "n.txt" });
		}
	}

	it("does not replay prepare() on a second build", async () => {
		const mail = new Welcome();
		await mail.buildWithContents();
		const again = await mail.build();

		// prepare() ran against the same builder both times, so every recipient
		// and every attachment was added twice: inspecting a mail and then
		// sending it delivered it twice to the same address.
		expect(again.to).toEqual(["a@b.c"]);
		expect(again.attachments?.length ?? 0).toBe(1);
	});

	it("hands back the same message it built the first time", async () => {
		const mail = new Welcome();
		const first = await mail.build();
		const second = await mail.build();

		expect(second).toBe(first);
	});

	it("reports whether it has been built", async () => {
		const mail = new Welcome();
		expect(mail.built).toBe(false);
		await mail.build();
		expect(mail.built).toBe(true);
	});

	it("survives being sent twice", async () => {
		const mail = new Welcome();
		const sent: Array<{ to: string[] }> = [];
		const mailer = {
			async send(m: BaseMail) {
				sent.push({ to: (await m.build()).to.slice() });
			},
			async sendLater() {},
		};

		await mail.send(mailer);
		await mail.send(mailer);

		expect(sent.map((s) => s.to)).toEqual([["a@b.c"], ["a@b.c"]]);
	});
});
