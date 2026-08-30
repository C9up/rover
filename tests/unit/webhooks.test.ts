import { Buffer } from "node:buffer";
import {
	createHmac,
	createSign,
	sign as edSign,
	generateKeyPairSync,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
	WebhookEmitter,
	WebhookHttpContext,
	WebhookResponse,
} from "../../src/webhooks/context.js";
import { createMailgunWebhookHandler } from "../../src/webhooks/mailgun.js";
import { createResendWebhookHandler } from "../../src/webhooks/resend.js";
import { createSendGridWebhookHandler } from "../../src/webhooks/sendgrid.js";

const freshTimestamp = (): string => Math.floor(Date.now() / 1000).toString();

class Emitter implements WebhookEmitter {
	events: Array<{ name: string; data: unknown }> = [];
	emit(name: string, data: unknown): void {
		this.events.push({ name, data });
	}
}

interface MockResponse extends WebhookResponse {
	_status: number;
	_body: unknown;
}

const makeResponse = (): MockResponse => {
	const r: MockResponse = {
		_status: 0,
		_body: undefined,
		status(code: number) {
			r._status = code;
			return r;
		},
		header(_n: string, _v: string) {
			return r;
		},
		json(data: unknown) {
			r._body = data;
		},
	};
	return r;
};

const makeCtx = (
	body: Buffer,
	headers: Record<string, string> = {},
): { ctx: WebhookHttpContext; res: MockResponse } => {
	const res = makeResponse();
	const lowered: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers)) {
		lowered[k.toLowerCase()] = v;
	}
	return {
		ctx: {
			request: {
				header: (name) => lowered[name.toLowerCase()],
				rawBody: () => body,
			},
			response: res,
		},
		res,
	};
};

describe("rover > webhooks > Mailgun", () => {
	const signingKey = "mailgun-test-signing-key";

	it("verifies HMAC signature and emits mail.delivered on `delivered` event", async () => {
		const timestamp = freshTimestamp();
		const token = "abc123";
		const signature = createHmac("sha256", signingKey)
			.update(`${timestamp}${token}`)
			.digest("hex");
		const body = Buffer.from(
			JSON.stringify({
				signature: { timestamp, token, signature },
				"event-data": {
					event: "delivered",
					recipient: "user@example.com",
					message: { headers: { "message-id": "mg-msg-1" } },
					timestamp: Number(timestamp),
				},
			}),
		);
		const emitter = new Emitter();
		const handler = createMailgunWebhookHandler({ signingKey, emitter });
		const { ctx, res } = makeCtx(body);

		await handler(ctx, async () => {});

		expect(res._status).toBe(200);
		expect(emitter.events).toHaveLength(1);
		expect(emitter.events[0].name).toBe("mail.delivered");
		const ev = emitter.events[0].data as { messageId: string; to: string };
		expect(ev.messageId).toBe("mg-msg-1");
		expect(ev.to).toBe("user@example.com");
	});

	it("emits a finite timestamp when event-data.timestamp is malformed", async () => {
		const timestamp = freshTimestamp();
		const token = "abc123";
		const signature = createHmac("sha256", signingKey)
			.update(`${timestamp}${token}`)
			.digest("hex");
		const body = Buffer.from(
			JSON.stringify({
				signature: { timestamp, token, signature },
				"event-data": {
					event: "delivered",
					recipient: "user@example.com",
					message: { headers: { "message-id": "mg-bad-ts" } },
					// Malformed: a non-numeric timestamp must not leak NaN.
					timestamp: "not-a-number",
				},
			}),
		);
		const emitter = new Emitter();
		const handler = createMailgunWebhookHandler({ signingKey, emitter });
		const { ctx, res } = makeCtx(body);

		await handler(ctx, async () => {});

		expect(res._status).toBe(200);
		const ev = emitter.events[0].data as { timestamp: number };
		expect(Number.isNaN(ev.timestamp)).toBe(false);
		expect(Number.isFinite(ev.timestamp)).toBe(true);
		expect(ev.timestamp).toBeGreaterThan(0);
	});

	it("maps `permanent_fail` to mail.bounced", async () => {
		const timestamp = freshTimestamp();
		const token = "abc123";
		const signature = createHmac("sha256", signingKey)
			.update(`${timestamp}${token}`)
			.digest("hex");
		const body = Buffer.from(
			JSON.stringify({
				signature: { timestamp, token, signature },
				"event-data": {
					event: "permanent_fail",
					recipient: "bad@example.com",
					reason: "Mailbox not found",
				},
			}),
		);
		const emitter = new Emitter();
		const handler = createMailgunWebhookHandler({ signingKey, emitter });
		const { ctx, res } = makeCtx(body);

		await handler(ctx, async () => {});

		expect(res._status).toBe(200);
		expect(emitter.events[0].name).toBe("mail.bounced");
	});

	it("rejects tampered signature with 401", async () => {
		const timestamp = freshTimestamp();
		const token = "abc123";
		const body = Buffer.from(
			JSON.stringify({
				signature: { timestamp, token, signature: "deadbeef".repeat(8) },
				"event-data": { event: "delivered", recipient: "u@example.com" },
			}),
		);
		const emitter = new Emitter();
		const handler = createMailgunWebhookHandler({ signingKey, emitter });
		const { ctx, res } = makeCtx(body);

		await handler(ctx, async () => {});

		expect(res._status).toBe(401);
		expect(emitter.events).toHaveLength(0);
	});

	it("rejects body without signature block with 401", async () => {
		const body = Buffer.from(
			JSON.stringify({ "event-data": { event: "delivered" } }),
		);
		const emitter = new Emitter();
		const handler = createMailgunWebhookHandler({ signingKey, emitter });
		const { ctx, res } = makeCtx(body);

		await handler(ctx, async () => {});

		expect(res._status).toBe(401);
	});

	it("rejects stale signature (beyond maxAgeSeconds window) with 401", async () => {
		const timestamp = "1700000000"; // fixed old timestamp (2023-11-14)
		const token = "abc123";
		const signature = createHmac("sha256", signingKey)
			.update(`${timestamp}${token}`)
			.digest("hex");
		const body = Buffer.from(
			JSON.stringify({
				signature: { timestamp, token, signature },
				"event-data": { event: "delivered", recipient: "u@x.com" },
			}),
		);
		const emitter = new Emitter();
		const handler = createMailgunWebhookHandler({ signingKey, emitter });
		const { ctx, res } = makeCtx(body);

		await handler(ctx, async () => {});

		expect(res._status).toBe(401);
		expect(res._body).toEqual({ error: "stale_signature" });
		expect(emitter.events).toHaveLength(0);
	});

	it("emitter error does not fail the webhook response", async () => {
		const timestamp = freshTimestamp();
		const token = "abc";
		const signature = createHmac("sha256", signingKey)
			.update(`${timestamp}${token}`)
			.digest("hex");
		const body = Buffer.from(
			JSON.stringify({
				signature: { timestamp, token, signature },
				"event-data": { event: "delivered", recipient: "u@x.com" },
			}),
		);
		const throwingEmitter: WebhookEmitter = {
			emit() {
				throw new Error("bus down");
			},
		};
		const handler = createMailgunWebhookHandler({
			signingKey,
			emitter: throwingEmitter,
		});
		const { ctx, res } = makeCtx(body);

		await handler(ctx, async () => {});

		expect(res._status).toBe(200);
	});
});

describe("rover > webhooks > SendGrid", () => {
	// Generate a fresh Ed25519 keypair per test run so we don't need a baked-in key.
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const publicKeyPem = publicKey
		.export({ format: "pem", type: "spki" })
		.toString();

	it("verifies Ed25519 and emits per event entry", async () => {
		const timestamp = freshTimestamp();
		const events = [
			{
				event: "delivered",
				email: "a@example.com",
				sg_message_id: "sg-1",
				timestamp: 1700000001,
			},
			{
				event: "bounce",
				email: "b@example.com",
				sg_message_id: "sg-2",
				reason: "550",
				timestamp: 1700000002,
			},
		];
		const body = Buffer.from(JSON.stringify(events));
		const toSign = Buffer.concat([Buffer.from(timestamp, "utf8"), body]);
		const signature = edSign(null, toSign, privateKey).toString("base64");

		const emitter = new Emitter();
		const handler = createSendGridWebhookHandler({
			publicKey: publicKeyPem,
			emitter,
		});
		const { ctx, res } = makeCtx(body, {
			"x-twilio-email-event-webhook-signature": signature,
			"x-twilio-email-event-webhook-timestamp": timestamp,
		});

		await handler(ctx, async () => {});

		expect(res._status).toBe(200);
		const names = emitter.events.map((e) => e.name);
		expect(names).toEqual(["mail.delivered", "mail.bounced"]);
	});

	it("emits a finite timestamp when an event entry's timestamp is malformed", async () => {
		const timestamp = freshTimestamp();
		const events = [
			{
				event: "delivered",
				email: "a@example.com",
				sg_message_id: "sg-bad-ts",
				// Malformed timestamp (non-numeric) — `"garbage" * 1000` is
				// NaN without the Number.isFinite guard.
				timestamp: "garbage",
			},
		];
		const body = Buffer.from(JSON.stringify(events));
		const toSign = Buffer.concat([Buffer.from(timestamp, "utf8"), body]);
		const signature = edSign(null, toSign, privateKey).toString("base64");

		const emitter = new Emitter();
		const handler = createSendGridWebhookHandler({
			publicKey: publicKeyPem,
			emitter,
		});
		const { ctx, res } = makeCtx(body, {
			"x-twilio-email-event-webhook-signature": signature,
			"x-twilio-email-event-webhook-timestamp": timestamp,
		});

		await handler(ctx, async () => {});

		expect(res._status).toBe(200);
		const ev = emitter.events[0].data as { timestamp: number };
		expect(Number.isNaN(ev.timestamp)).toBe(false);
		expect(Number.isFinite(ev.timestamp)).toBe(true);
		expect(ev.timestamp).toBeGreaterThan(0);
	});

	it("rejects tampered signature with 401", async () => {
		const body = Buffer.from(JSON.stringify([{ event: "delivered" }]));
		const emitter = new Emitter();
		const handler = createSendGridWebhookHandler({
			publicKey: publicKeyPem,
			emitter,
		});
		const { ctx, res } = makeCtx(body, {
			"x-twilio-email-event-webhook-signature": Buffer.alloc(64, 0).toString(
				"base64",
			),
			"x-twilio-email-event-webhook-timestamp": freshTimestamp(),
		});

		await handler(ctx, async () => {});

		expect(res._status).toBe(401);
		expect(emitter.events).toHaveLength(0);
	});

	it("rejects missing signature headers with 401", async () => {
		const body = Buffer.from(JSON.stringify([{ event: "delivered" }]));
		const emitter = new Emitter();
		const handler = createSendGridWebhookHandler({
			publicKey: publicKeyPem,
			emitter,
		});
		const { ctx, res } = makeCtx(body);

		await handler(ctx, async () => {});

		expect(res._status).toBe(401);
	});
});

describe("rover > webhooks > Resend", () => {
	const secret = Buffer.from("resend-secret-key-123").toString("base64");

	it("verifies Svix HMAC and emits mail.delivered", async () => {
		const id = "msg_123";
		const timestamp = freshTimestamp();
		const body = Buffer.from(
			JSON.stringify({
				type: "email.delivered",
				data: {
					email_id: "res-abc",
					to: ["user@example.com"],
					created_at: "2024-01-01T00:00:00.000Z",
				},
			}),
		);
		const toSign = Buffer.concat([
			Buffer.from(`${id}.${timestamp}.`, "utf8"),
			body,
		]);
		const keyBytes = Buffer.from(secret, "base64");
		const sig = createHmac("sha256", keyBytes).update(toSign).digest("base64");

		const emitter = new Emitter();
		const handler = createResendWebhookHandler({ secret, emitter });
		const { ctx, res } = makeCtx(body, {
			"svix-id": id,
			"svix-timestamp": timestamp,
			"svix-signature": `v1,${sig}`,
		});

		await handler(ctx, async () => {});

		expect(res._status).toBe(200);
		expect(emitter.events).toHaveLength(1);
		expect(emitter.events[0].name).toBe("mail.delivered");
		const ev = emitter.events[0].data as { messageId: string; to: string };
		expect(ev.messageId).toBe("res-abc");
		expect(ev.to).toBe("user@example.com");
	});

	it("emits a finite timestamp (Date.now fallback) for a malformed created_at", async () => {
		const id = "msg_bad_date";
		const timestamp = freshTimestamp();
		const body = Buffer.from(
			JSON.stringify({
				type: "email.delivered",
				data: {
					email_id: "res-bad",
					to: ["user@example.com"],
					created_at: "not-a-date",
				},
			}),
		);
		const toSign = Buffer.concat([
			Buffer.from(`${id}.${timestamp}.`, "utf8"),
			body,
		]);
		const keyBytes = Buffer.from(secret, "base64");
		const sig = createHmac("sha256", keyBytes).update(toSign).digest("base64");

		const emitter = new Emitter();
		const handler = createResendWebhookHandler({ secret, emitter });
		const { ctx, res } = makeCtx(body, {
			"svix-id": id,
			"svix-timestamp": timestamp,
			"svix-signature": `v1,${sig}`,
		});

		await handler(ctx, async () => {});

		expect(res._status).toBe(200);
		expect(emitter.events).toHaveLength(1);
		const ev = emitter.events[0].data as { timestamp: number };
		// The bug: `new Date("not-a-date").getTime()` is NaN. The guard
		// must fall back to a real epoch-ms value instead of leaking NaN.
		expect(Number.isNaN(ev.timestamp)).toBe(false);
		expect(Number.isFinite(ev.timestamp)).toBe(true);
		expect(ev.timestamp).toBeGreaterThan(0);
	});

	it("preserves a valid created_at as its exact epoch-ms", async () => {
		const id = "msg_good_date";
		const timestamp = freshTimestamp();
		const body = Buffer.from(
			JSON.stringify({
				type: "email.delivered",
				data: {
					email_id: "res-good",
					to: ["user@example.com"],
					created_at: "2024-01-01T00:00:00.000Z",
				},
			}),
		);
		const toSign = Buffer.concat([
			Buffer.from(`${id}.${timestamp}.`, "utf8"),
			body,
		]);
		const keyBytes = Buffer.from(secret, "base64");
		const sig = createHmac("sha256", keyBytes).update(toSign).digest("base64");

		const emitter = new Emitter();
		const handler = createResendWebhookHandler({ secret, emitter });
		const { ctx, res } = makeCtx(body, {
			"svix-id": id,
			"svix-timestamp": timestamp,
			"svix-signature": `v1,${sig}`,
		});

		await handler(ctx, async () => {});

		expect(res._status).toBe(200);
		const ev = emitter.events[0].data as { timestamp: number };
		expect(ev.timestamp).toBe(Date.parse("2024-01-01T00:00:00.000Z"));
	});

	it("rejects tampered signature with 401", async () => {
		const body = Buffer.from(
			JSON.stringify({ type: "email.delivered", data: {} }),
		);
		const emitter = new Emitter();
		const handler = createResendWebhookHandler({ secret, emitter });
		const { ctx, res } = makeCtx(body, {
			"svix-id": "msg_123",
			"svix-timestamp": "1700000000",
			"svix-signature": "v1,Zm9v",
		});

		await handler(ctx, async () => {});

		expect(res._status).toBe(401);
	});

	it("accepts whsec_ prefixed secrets identically", async () => {
		const id = "msg_123";
		const timestamp = freshTimestamp();
		const body = Buffer.from(
			JSON.stringify({
				type: "email.bounced",
				data: { email_id: "r1", to: "u@x.com", reason: "bounce" },
			}),
		);
		const toSign = Buffer.concat([
			Buffer.from(`${id}.${timestamp}.`, "utf8"),
			body,
		]);
		const keyBytes = Buffer.from(secret, "base64");
		const sig = createHmac("sha256", keyBytes).update(toSign).digest("base64");

		const emitter = new Emitter();
		const handler = createResendWebhookHandler({
			secret: `whsec_${secret}`,
			emitter,
		});
		const { ctx, res } = makeCtx(body, {
			"svix-id": id,
			"svix-timestamp": timestamp,
			"svix-signature": `v1,${sig}`,
		});

		await handler(ctx, async () => {});

		expect(res._status).toBe(200);
		expect(emitter.events[0].name).toBe("mail.bounced");
	});
});

// Silence unused import warnings from crypto — some adapters only import for side effects.
void createSign;

describe("rover > the Resend signing secret is validated at config time", () => {
	const valid = Buffer.from("k".repeat(24)).toString("base64");

	it("takes the secret with or without its whsec_ prefix", () => {
		expect(() =>
			createResendWebhookHandler({ secret: `whsec_${valid}` }),
		).not.toThrow();
		expect(() => createResendWebhookHandler({ secret: valid })).not.toThrow();
	});

	it("refuses a secret that is not base64", () => {
		// `Buffer.from(x, "base64")` never fails — it skips what it cannot read.
		// So a mistyped secret becomes a short deterministic key, and every
		// delivery then fails verification and looks like an attack.
		expect(() =>
			createResendWebhookHandler({ secret: "whsec_not base64 at all!!" }),
		).toThrow(/not valid base64/);
	});

	it("refuses a secret too short to sign with", () => {
		expect(() =>
			createResendWebhookHandler({
				secret: Buffer.from("short").toString("base64"),
			}),
		).toThrow(/too short to sign with/);
	});

	it("still refuses an absent secret", () => {
		expect(() => createResendWebhookHandler({ secret: "" })).toThrow(
			/secret is required/,
		);
	});
});
