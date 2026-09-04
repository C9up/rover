import { Buffer } from "node:buffer";
import { createHmac, sign as edSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
	WebhookEmitter,
	WebhookHttpContext,
	WebhookResponse,
} from "../../src/webhooks/context.js";
import { createMailgunWebhookHandler } from "../../src/webhooks/mailgun.js";
import { createResendWebhookHandler } from "../../src/webhooks/resend.js";
import { createSendGridWebhookHandler } from "../../src/webhooks/sendgrid.js";
import { defined } from "../__helpers__/defined.js";

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

function makeResponse(): MockResponse {
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
}

function makeCtx(
	body: Buffer,
	headers: Record<string, string> = {},
): { ctx: WebhookHttpContext; res: MockResponse } {
	const res = makeResponse();
	const lowered: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers)) lowered[k.toLowerCase()] = v;
	return {
		ctx: {
			request: {
				rawBody() {
					return Promise.resolve(body);
				},
				header(name) {
					return lowered[name.toLowerCase()];
				},
			},
			response: res,
		},
		res,
	};
}

const freshTimestamp = (): string => Math.floor(Date.now() / 1000).toString();

describe("rover > webhooks > SendGrid edge cases", () => {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const publicKeyPem = publicKey
		.export({ type: "spki", format: "pem" })
		.toString();
	// Strip PEM header/footer to test the base64-DER input branch.
	const publicKeyBase64 = publicKeyPem
		.replace(/-----BEGIN PUBLIC KEY-----/, "")
		.replace(/-----END PUBLIC KEY-----/, "")
		.replace(/\s/g, "");

	it("rejects a non-numeric timestamp header with 401 invalid_signature", async () => {
		const body = Buffer.from(JSON.stringify([{ event: "delivered" }]));
		const emitter = new Emitter();
		const handler = createSendGridWebhookHandler({
			publicKey: publicKeyPem,
			emitter,
		});
		const { ctx, res } = makeCtx(body, {
			"x-twilio-email-event-webhook-signature": "AAA",
			"x-twilio-email-event-webhook-timestamp": "not-a-number",
		});
		await handler(ctx, async () => {});
		expect(res._status).toBe(401);
		expect(res._body).toEqual({ error: "invalid_signature" });
	});

	it("rejects a stale timestamp (beyond maxAgeSeconds) with stale_signature", async () => {
		const body = Buffer.from(JSON.stringify([{ event: "delivered" }]));
		const emitter = new Emitter();
		const handler = createSendGridWebhookHandler({
			publicKey: publicKeyPem,
			emitter,
		});
		const { ctx, res } = makeCtx(body, {
			"x-twilio-email-event-webhook-signature": "AAA",
			"x-twilio-email-event-webhook-timestamp": "1700000000",
		});
		await handler(ctx, async () => {});
		expect(res._status).toBe(401);
		expect(res._body).toEqual({ error: "stale_signature" });
	});

	it("rejects malformed JSON body with 400 invalid_json", async () => {
		const body = Buffer.from("{not json");
		const timestamp = freshTimestamp();
		const toSign = Buffer.concat([Buffer.from(timestamp, "utf8"), body]);
		const sig = edSign(null, toSign, privateKey).toString("base64");
		const emitter = new Emitter();
		const handler = createSendGridWebhookHandler({
			publicKey: publicKeyPem,
			emitter,
		});
		const { ctx, res } = makeCtx(body, {
			"x-twilio-email-event-webhook-signature": sig,
			"x-twilio-email-event-webhook-timestamp": timestamp,
		});
		await handler(ctx, async () => {});
		expect(res._status).toBe(400);
		expect(res._body).toEqual({ error: "invalid_json" });
	});

	it("rejects a JSON object body that isn't an array with 400 expected_event_array", async () => {
		const body = Buffer.from(JSON.stringify({ event: "delivered" }));
		const timestamp = freshTimestamp();
		const toSign = Buffer.concat([Buffer.from(timestamp, "utf8"), body]);
		const sig = edSign(null, toSign, privateKey).toString("base64");
		const emitter = new Emitter();
		const handler = createSendGridWebhookHandler({
			publicKey: publicKeyPem,
			emitter,
		});
		const { ctx, res } = makeCtx(body, {
			"x-twilio-email-event-webhook-signature": sig,
			"x-twilio-email-event-webhook-timestamp": timestamp,
		});
		await handler(ctx, async () => {});
		expect(res._status).toBe(400);
		expect(res._body).toEqual({ error: "expected_event_array" });
	});

	it("accepts a base64-DER public key (no PEM header) — toPem() wraps it", async () => {
		const events = [{ event: "delivered", email: "u@x.com" }];
		const body = Buffer.from(JSON.stringify(events));
		const timestamp = freshTimestamp();
		const toSign = Buffer.concat([Buffer.from(timestamp, "utf8"), body]);
		const sig = edSign(null, toSign, privateKey).toString("base64");
		const emitter = new Emitter();
		const handler = createSendGridWebhookHandler({
			publicKey: publicKeyBase64, // un-wrapped
			emitter,
		});
		const { ctx, res } = makeCtx(body, {
			"x-twilio-email-event-webhook-signature": sig,
			"x-twilio-email-event-webhook-timestamp": timestamp,
		});
		await handler(ctx, async () => {});
		expect(res._status).toBe(200);
		expect(emitter.events[0]?.name).toBe("mail.delivered");
	});

	it("ignores events whose `event` field has no mapping in EVENT_MAP", async () => {
		const events = [
			{ event: "open", email: "u@x.com" }, // not mapped
			{ event: "delivered", email: "u@x.com" },
		];
		const body = Buffer.from(JSON.stringify(events));
		const timestamp = freshTimestamp();
		const toSign = Buffer.concat([Buffer.from(timestamp, "utf8"), body]);
		const sig = edSign(null, toSign, privateKey).toString("base64");
		const emitter = new Emitter();
		const handler = createSendGridWebhookHandler({
			publicKey: publicKeyPem,
			emitter,
		});
		const { ctx, res } = makeCtx(body, {
			"x-twilio-email-event-webhook-signature": sig,
			"x-twilio-email-event-webhook-timestamp": timestamp,
		});
		await handler(ctx, async () => {});
		expect(res._status).toBe(200);
		expect(emitter.events.map((e) => e.name)).toEqual(["mail.delivered"]);
	});

	it("preserves a millisecond-precision event timestamp without re-multiplying", async () => {
		const msTimestamp = Date.now(); // > 1e12
		const events = [
			{ event: "delivered", email: "u@x.com", timestamp: msTimestamp },
		];
		const body = Buffer.from(JSON.stringify(events));
		const timestamp = freshTimestamp();
		const toSign = Buffer.concat([Buffer.from(timestamp, "utf8"), body]);
		const sig = edSign(null, toSign, privateKey).toString("base64");
		const emitter = new Emitter();
		const handler = createSendGridWebhookHandler({
			publicKey: publicKeyPem,
			emitter,
		});
		const { ctx } = makeCtx(body, {
			"x-twilio-email-event-webhook-signature": sig,
			"x-twilio-email-event-webhook-timestamp": timestamp,
		});
		await handler(ctx, async () => {});
		const ev = defined(emitter.events[0]).data as { timestamp: number };
		expect(ev.timestamp).toBe(msTimestamp);
	});

	it("constructor throws when publicKey is empty", () => {
		const emitter = new Emitter();
		expect(() =>
			createSendGridWebhookHandler({ publicKey: "", emitter }),
		).toThrow(/publicKey is required/);
	});
});

describe("rover > webhooks > Resend edge cases", () => {
	const secret = Buffer.from("resend-secret-key-123").toString("base64");

	it("rejects request with missing svix-* headers", async () => {
		const body = Buffer.from(JSON.stringify({ type: "email.delivered" }));
		const emitter = new Emitter();
		const handler = createResendWebhookHandler({ secret, emitter });
		const { ctx, res } = makeCtx(body); // no headers at all
		await handler(ctx, async () => {});
		expect(res._status).toBe(401);
	});

	it("rejects body that isn't valid JSON with 400", async () => {
		const id = "msg_999";
		const timestamp = freshTimestamp();
		const body = Buffer.from("not-json");
		const toSign = Buffer.concat([
			Buffer.from(`${id}.${timestamp}.`, "utf8"),
			body,
		]);
		const sig = createHmac("sha256", Buffer.from(secret, "base64"))
			.update(toSign)
			.digest("base64");
		const emitter = new Emitter();
		const handler = createResendWebhookHandler({ secret, emitter });
		const { ctx, res } = makeCtx(body, {
			"svix-id": id,
			"svix-timestamp": timestamp,
			"svix-signature": `v1,${sig}`,
		});
		await handler(ctx, async () => {});
		expect(res._status).toBe(400);
	});

	it("ignores resend events whose type doesn't map to a mail.* event", async () => {
		const id = "msg_777";
		const timestamp = freshTimestamp();
		const body = Buffer.from(
			JSON.stringify({ type: "email.opened", data: { email_id: "x" } }),
		);
		const toSign = Buffer.concat([
			Buffer.from(`${id}.${timestamp}.`, "utf8"),
			body,
		]);
		const sig = createHmac("sha256", Buffer.from(secret, "base64"))
			.update(toSign)
			.digest("base64");
		const emitter = new Emitter();
		const handler = createResendWebhookHandler({ secret, emitter });
		const { ctx, res } = makeCtx(body, {
			"svix-id": id,
			"svix-timestamp": timestamp,
			"svix-signature": `v1,${sig}`,
		});
		await handler(ctx, async () => {});
		expect(res._status).toBe(200);
		expect(emitter.events).toHaveLength(0);
	});
});

describe("rover > webhooks > Mailgun edge cases", () => {
	const signingKey = "mailgun-secret";

	it("ignores events with type not in EVENT_MAP", async () => {
		const timestamp = freshTimestamp();
		const token = "tok";
		const sig = createHmac("sha256", signingKey)
			.update(`${timestamp}${token}`)
			.digest("hex");
		const body = Buffer.from(
			JSON.stringify({
				signature: { timestamp, token, signature: sig },
				"event-data": { event: "opened", recipient: "u@x.com" }, // unmapped
			}),
		);
		const emitter = new Emitter();
		const handler = createMailgunWebhookHandler({ signingKey, emitter });
		const { ctx, res } = makeCtx(body);
		await handler(ctx, async () => {});
		expect(res._status).toBe(200);
		expect(emitter.events).toHaveLength(0);
	});

	it("rejects malformed JSON body with 400", async () => {
		const body = Buffer.from("not-json");
		const emitter = new Emitter();
		const handler = createMailgunWebhookHandler({ signingKey, emitter });
		const { ctx, res } = makeCtx(body);
		await handler(ctx, async () => {});
		expect(res._status).toBeGreaterThanOrEqual(400);
	});
});
