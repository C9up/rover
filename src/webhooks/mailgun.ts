import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { emitSafely } from "../emitSafely.js";
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
}

interface MailgunPayload {
	signature?: { timestamp?: string; token?: string; signature?: string };
	"event-data"?: {
		event?: string;
		recipient?: string;
		reason?: string;
		message?: { headers?: { "message-id"?: string } };
		timestamp?: number;
	};
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

	return async (ctx: WebhookHttpContext, _next): Promise<void> => {
		const raw = await Promise.resolve(ctx.request.rawBody());
		let payload: MailgunPayload;
		try {
			payload = JSON.parse(raw.toString("utf8")) as MailgunPayload;
		} catch {
			// Collapse parse-failure and signature-failure to the same 401 so
			// the response doesn't leak which branch rejected.
			ctx.response.status(401).json({ error: "invalid_signature" });
			return;
		}
		const sig = payload.signature;
		if (!sig?.timestamp || !sig?.token || !sig?.signature) {
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

		const data = payload["event-data"];
		if (!data?.event) {
			ctx.response.status(400).json({ error: "missing_event" });
			return;
		}
		const eventName = EVENT_MAP[data.event];
		if (eventName) {
			try {
				emitSafely(emitter, eventName, {
					messageId: data.message?.headers?.["message-id"] ?? "",
					to: data.recipient ?? "",
					reason: data.reason,
					// Some Mailgun event types report `timestamp` already in
					// milliseconds; detect magnitude rather than blindly *1000.
					timestamp: normaliseTimestamp(data.timestamp),
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
