import { Buffer } from "node:buffer";
import { createPublicKey, verify } from "node:crypto";
import { emitSafely } from "../emitSafely.js";
import type {
	WebhookEmitter,
	WebhookHttpContext,
	WebhookMiddleware,
} from "./context.js";

export interface SendGridWebhookOptions {
	/** Base64-DER or PEM-encoded Ed25519 public key, as shown in the SendGrid dashboard. */
	publicKey: string;
	emitter: WebhookEmitter;
	/**
	 * Maximum age in seconds for a signed payload (default 300 = 5 minutes).
	 * Set to `Number.POSITIVE_INFINITY` to disable (not recommended).
	 */
	maxAgeSeconds?: number;
}

interface SendGridEvent {
	event?: string;
	email?: string;
	sg_message_id?: string;
	reason?: string;
	timestamp?: number;
}

const EVENT_MAP: Record<string, string> = {
	delivered: "mail.delivered",
	bounce: "mail.bounced",
	dropped: "mail.failed",
	deferred: "mail.failed",
	blocked: "mail.failed",
};

export function createSendGridWebhookHandler(
	options: SendGridWebhookOptions,
): WebhookMiddleware {
	if (!options.publicKey) {
		throw new Error(
			"createSendGridWebhookHandler: publicKey is required for Ed25519 verification.",
		);
	}
	const pemKey = toPem(options.publicKey);
	const key = createPublicKey(pemKey);
	const emitter = options.emitter;
	const maxAgeSeconds = options.maxAgeSeconds ?? 300;

	return async (ctx: WebhookHttpContext, _next): Promise<void> => {
		const raw = await Promise.resolve(ctx.request.rawBody());
		const signature = ctx.request.header(
			"x-twilio-email-event-webhook-signature",
		);
		const timestamp = ctx.request.header(
			"x-twilio-email-event-webhook-timestamp",
		);
		if (!signature || !timestamp) {
			ctx.response.status(401).json({ error: "missing_signature" });
			return;
		}
		const tsSeconds = Number(timestamp);
		if (!Number.isFinite(tsSeconds)) {
			ctx.response.status(401).json({ error: "invalid_signature" });
			return;
		}
		const nowSeconds = Date.now() / 1000;
		if (Math.abs(nowSeconds - tsSeconds) > maxAgeSeconds) {
			ctx.response.status(401).json({ error: "stale_signature" });
			return;
		}
		const payloadToVerify = Buffer.concat([
			Buffer.from(timestamp, "utf8"),
			raw,
		]);
		let sigBytes: Buffer;
		try {
			sigBytes = Buffer.from(signature, "base64");
		} catch {
			ctx.response.status(401).json({ error: "invalid_signature" });
			return;
		}
		const ok = verify(null, payloadToVerify, key, sigBytes);
		if (!ok) {
			ctx.response.status(401).json({ error: "invalid_signature" });
			return;
		}

		let events: SendGridEvent[];
		try {
			events = JSON.parse(raw.toString("utf8")) as SendGridEvent[];
		} catch {
			ctx.response.status(400).json({ error: "invalid_json" });
			return;
		}
		if (!Array.isArray(events)) {
			ctx.response.status(400).json({ error: "expected_event_array" });
			return;
		}
		for (const ev of events) {
			if (!ev.event) continue;
			const mapped = EVENT_MAP[ev.event];
			if (!mapped) continue;
			try {
				emitSafely(emitter, mapped, {
					messageId: ev.sg_message_id ?? "",
					to: ev.email ?? "",
					reason: ev.reason,
					timestamp: normaliseTimestamp(ev.timestamp),
				});
			} catch {
				// Never let emitter failures flip the webhook response.
			}
		}
		ctx.response.status(200).json({ ok: true });
	};
}

function toPem(key: string): string {
	const normalised = key.replace(/\r\n/g, "\n");
	if (normalised.includes("BEGIN PUBLIC KEY")) return normalised;
	const der = normalised.replace(/\s/g, "");
	return `-----BEGIN PUBLIC KEY-----\n${der}\n-----END PUBLIC KEY-----`;
}

function normaliseTimestamp(ts: number | undefined): number {
	// Guard non-finite values (NaN / ±Infinity): a malformed `timestamp`
	// field in the webhook JSON would otherwise multiply into NaN and
	// leak into the emitted mail.* event, breaking consumers that sort
	// / persist / compare timestamps numerically.
	if (ts === undefined || !Number.isFinite(ts)) return Date.now();
	if (ts > 1e12) return ts;
	return ts * 1000;
}
