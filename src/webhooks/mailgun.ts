import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { emitSafely } from "../emitSafely.js";
import { field, numberField, stringField } from "../guards.js";
import type {
	WebhookEmitter,
	WebhookHttpContext,
	WebhookMiddleware,
} from "./context.js";

export interface MailgunWebhookOptions {
	signingKey: string;
	emitter: WebhookEmitter;
	/**
	 * Maximum age in seconds for a signed payload (default 300 = 5 minutes).
	 * Protects against replay of a legitimately-signed body captured elsewhere.
	 * Set to `Number.POSITIVE_INFINITY` to disable (not recommended).
	 */
	maxAgeSeconds?: number;
	/**
	 * Where used signature tokens are remembered. Mailgun's HMAC covers the
	 * timestamp and token, NOT the event data, so a captured signature block
	 * would authenticate any body for the whole window; refusing a token seen
	 * before is what ties one signature to one delivery. The default lives in
	 * this process: behind several instances, pass a shared store (Redis
	 * `SET token 1 NX EX ttl`).
	 */
	tokenStore?: WebhookTokenStore;
}

/** Remembers webhook signature tokens so each one is accepted only once. */
export interface WebhookTokenStore {
	/**
	 * Record `token` for `ttlSeconds`. Resolve `false` when it was already
	 * recorded, i.e. the request is a replay. Must be atomic: two concurrent
	 * deliveries of the same token must not both get `true`.
	 */
	claim(token: string, ttlSeconds: number): boolean | Promise<boolean>;
}

/**
 * In-process {@link WebhookTokenStore}. Bounded: past `maxEntries` the oldest
 * token is forgotten. Only tokens whose signature verified reach it, so its
 * growth follows genuine Mailgun deliveries, not attacker input.
 */
export class MemoryWebhookTokenStore implements WebhookTokenStore {
	readonly #expiries = new Map<string, number>();
	readonly #maxEntries: number;

	constructor(options: { maxEntries?: number } = {}) {
		this.#maxEntries = options.maxEntries ?? 10_000;
	}

	get size(): number {
		return this.#expiries.size;
	}

	claim(token: string, ttlSeconds: number): boolean {
		const now = Date.now();
		const expiry = this.#expiries.get(token);
		if (expiry !== undefined && expiry > now) return false;
		this.#expiries.delete(token);
		for (const [key, until] of this.#expiries) {
			if (until > now && this.#expiries.size < this.#maxEntries) break;
			this.#expiries.delete(key);
		}
		this.#expiries.set(token, now + ttlSeconds * 1000);
		return true;
	}
}

const EVENT_MAP: Record<string, string> = {
	delivered: "mail.delivered",
	failed: "mail.failed",
	bounced: "mail.bounced",
	permanent_fail: "mail.bounced",
	temporary_fail: "mail.failed",
};

export function createMailgunWebhookHandler(
	options: MailgunWebhookOptions,
): WebhookMiddleware {
	if (!options.signingKey) {
		throw new Error(
			"createMailgunWebhookHandler: signingKey is required for HMAC verification.",
		);
	}
	const signingKey = options.signingKey;
	const emitter = options.emitter;
	const maxAgeSeconds = options.maxAgeSeconds ?? 300;
	const tokenStore = options.tokenStore ?? new MemoryWebhookTokenStore();
	// A token stays claimed as long as its timestamp is inside the window:
	// up to maxAgeSeconds on either side of now.
	const tokenTtlSeconds = Number.isFinite(maxAgeSeconds)
		? maxAgeSeconds * 2
		: Number.MAX_SAFE_INTEGER / 1000;

	return async (ctx: WebhookHttpContext): Promise<void> => {
		const raw = await Promise.resolve(ctx.request.rawBody());
		let payload: unknown;
		try {
			payload = JSON.parse(raw.toString("utf8"));
		} catch {
			// Collapse parse-failure and signature-failure to the same 401 so
			// the response doesn't leak which branch rejected.
			ctx.response.status(401).json({ error: "invalid_signature" });
			return;
		}
		const signatureBlock = field(payload, "signature");
		const sig = {
			timestamp: stringField(signatureBlock, "timestamp"),
			token: stringField(signatureBlock, "token"),
			signature: stringField(signatureBlock, "signature"),
		};
		if (!sig.timestamp || !sig.token || !sig.signature) {
			ctx.response.status(401).json({ error: "invalid_signature" });
			return;
		}

		// Enforce a replay-window BEFORE touching the HMAC so a very old
		// valid signature cannot replay forever.
		const tsSeconds = Number(sig.timestamp);
		if (!Number.isFinite(tsSeconds)) {
			ctx.response.status(401).json({ error: "invalid_signature" });
			return;
		}
		const nowSeconds = Date.now() / 1000;
		if (Math.abs(nowSeconds - tsSeconds) > maxAgeSeconds) {
			ctx.response.status(401).json({ error: "stale_signature" });
			return;
		}

		const expected = createHmac("sha256", signingKey)
			.update(`${sig.timestamp}${sig.token}`)
			.digest("hex");
		if (!constantTimeEqualHex(expected, sig.signature)) {
			ctx.response.status(401).json({ error: "invalid_signature" });
			return;
		}
		if (!(await tokenStore.claim(sig.token, tokenTtlSeconds))) {
			ctx.response.status(401).json({ error: "replayed_signature" });
			return;
		}

		const data = field(payload, "event-data");
		const event = stringField(data, "event");
		if (!event) {
			ctx.response.status(400).json({ error: "missing_event" });
			return;
		}
		const eventName = EVENT_MAP[event];
		if (eventName) {
			try {
				emitSafely(emitter, eventName, {
					messageId:
						stringField(
							field(field(data, "message"), "headers"),
							"message-id",
						) ?? "",
					to: stringField(data, "recipient") ?? "",
					reason: stringField(data, "reason"),
					// Some Mailgun event types report `timestamp` already in
					// milliseconds; detect magnitude rather than blindly *1000.
					timestamp: normaliseTimestamp(numberField(data, "timestamp")),
				});
			} catch {
				// Emitter failure must not fail the webhook response — providers
				// will retry on non-2xx and flood the bus.
			}
		}
		ctx.response.status(200).json({ ok: true });
	};
}

function constantTimeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	const bufA = Buffer.from(a, "hex");
	const bufB = Buffer.from(b, "hex");
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}

/**
 * Producers sometimes send seconds-since-epoch, sometimes ms. Values larger
 * than 1e12 are ms (post-2001 in ms); anything smaller is treated as seconds.
 */
function normaliseTimestamp(ts: number | undefined): number {
	// Guard non-finite values (NaN / ±Infinity): a malformed `timestamp`
	// field in the webhook payload would otherwise multiply into NaN and
	// leak into the emitted mail.* event, breaking consumers that sort
	// / persist / compare timestamps numerically.
	if (ts === undefined || !Number.isFinite(ts)) return Date.now();
	if (ts > 1e12) return ts;
	return ts * 1000;
}
