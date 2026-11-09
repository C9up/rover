import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { WebhookHttpContext } from "../../src/webhooks/context.js";
import {
	createMailgunWebhookHandler,
	MemoryWebhookTokenStore,
} from "../../src/webhooks/mailgun.js";

const signingKey = "mailgun-test-signing-key";

function signed(token: string, eventData: Record<string, unknown>): Buffer {
	const timestamp = Math.floor(Date.now() / 1000).toString();
	const signature = createHmac("sha256", signingKey)
		.update(`${timestamp}${token}`)
		.digest("hex");
	return Buffer.from(
		JSON.stringify({
			signature: { timestamp, token, signature },
			"event-data": eventData,
		}),
	);
}

async function post(
	handler: ReturnType<typeof createMailgunWebhookHandler>,
	body: Buffer,
): Promise<{ status: number; body: unknown }> {
	const out: { status: number; body: unknown } = {
		status: 0,
		body: undefined,
	};
	const response = {
		status(code: number) {
			out.status = code;
			return response;
		},
		header() {
			return response;
		},
		json(data: unknown) {
			out.body = data;
		},
	};
	const ctx: WebhookHttpContext = {
		request: { header: () => undefined, rawBody: () => body },
		response,
	};
	await handler(ctx, async () => {});
	return out;
}

const delivered = {
	event: "delivered",
	recipient: "alice@example.com",
	message: { headers: { "message-id": "m1" } },
};
const forged = {
	event: "failed",
	severity: "permanent",
	recipient: "ceo@example.com",
	reason: "forged",
	message: { headers: { "message-id": "m999" } },
};

describe("rover > webhooks > Mailgun token replay", () => {
	it("rejects a captured signature reused with a forged body", async () => {
		const events: string[] = [];
		const handler = createMailgunWebhookHandler({
			signingKey,
			emitter: { emit: (name: string) => events.push(name) },
		});
		const legit = signed("tok-1", delivered);
		expect((await post(handler, legit)).status).toBe(200);

		// Same signature block, different event-data: the HMAC does not cover
		// the body, so only the token's single use ties it to one delivery.
		const parsed: unknown = JSON.parse(legit.toString("utf8"));
		const signature =
			typeof parsed === "object" && parsed !== null
				? Reflect.get(parsed, "signature")
				: undefined;
		const replay = Buffer.from(
			JSON.stringify({ signature, "event-data": forged }),
		);
		const first = await post(handler, replay);
		expect(first).toEqual({
			status: 401,
			body: { error: "replayed_signature" },
		});
		expect((await post(handler, replay)).status).toBe(401);
		expect(events).toEqual(["mail.delivered"]);
	});

	it("accepts distinct tokens", async () => {
		const handler = createMailgunWebhookHandler({
			signingKey,
			emitter: { emit: () => undefined },
		});
		expect((await post(handler, signed("a", delivered))).status).toBe(200);
		expect((await post(handler, signed("b", delivered))).status).toBe(200);
	});

	it("uses a shared store when one is given (multi-instance deployments)", async () => {
		const seen = new Set<string>();
		const tokenStore = {
			claim(token: string): boolean {
				if (seen.has(token)) return false;
				seen.add(token);
				return true;
			},
		};
		const a = createMailgunWebhookHandler({
			signingKey,
			emitter: { emit: () => undefined },
			tokenStore,
		});
		const b = createMailgunWebhookHandler({
			signingKey,
			emitter: { emit: () => undefined },
			tokenStore,
		});
		const body = signed("shared", delivered);
		expect((await post(a, body)).status).toBe(200);
		expect((await post(b, body)).status).toBe(401);
	});

	it("does not record a token whose signature is invalid", async () => {
		const store = new MemoryWebhookTokenStore();
		const handler = createMailgunWebhookHandler({
			signingKey,
			emitter: { emit: () => undefined },
			tokenStore: store,
		});
		const body = Buffer.from(
			JSON.stringify({
				signature: {
					timestamp: Math.floor(Date.now() / 1000).toString(),
					token: "unsigned",
					signature: "00".repeat(32),
				},
				"event-data": delivered,
			}),
		);
		expect((await post(handler, body)).status).toBe(401);
		expect(store.size).toBe(0);
	});

	it("the in-memory store stays bounded and forgets expired tokens", () => {
		const store = new MemoryWebhookTokenStore({ maxEntries: 100 });
		for (let i = 0; i < 1000; i += 1) {
			expect(store.claim(`t${i}`, 300)).toBe(true);
		}
		expect(store.size).toBe(100);
		expect(store.claim("t999", 300)).toBe(false);

		const expiring = new MemoryWebhookTokenStore();
		expect(expiring.claim("x", 0)).toBe(true);
		expect(expiring.claim("x", 300)).toBe(true);
	});
});
