import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import type {
	WebhookEmitter,
	WebhookHttpContext,
	WebhookMiddleware,
} from "./context.js";

export interface ResendWebhookOptions {
	/**
	 * Webhook signing secret from the Resend dashboard. Supports the full
	 * `whsec_...` prefix or a raw base64-encoded key.
	 */
	secret: string;
	emitter: WebhookEmitter;
	/**
	 * Maximum age in seconds for a signed payload (default 300 = 5 minutes).
	 * Set to `Number.POSITIVE_INFINITY` to disable (not recommended).
	 */
	maxAgeSeconds?: number;
}

/**
 * Parse a provider-supplied `created_at` into an epoch-ms timestamp,
 * falling back to "now" for anything unparseable. Without the
 * `Number.isFinite` guard, a malformed value like `"not-a-date"`
 * yields `new Date(...).getTime()` === `NaN`, which then leaks into
 * the `mail.*` event payload and breaks any consumer that sorts,
 * persists, or numerically compares the timestamp.
 */
function parseTimestamp(raw: string | undefined): number {
	if (raw !== undefined && raw !== "") {
		const t = new Date(raw).getTime();
		if (Number.isFinite(t)) return t;
	}
	return Date.now();
}

interface ResendPayload {
	type?: string;
	data?: {
		email_id?: string;
		to?: string | string[];
		reason?: string;
		created_at?: string;
	};
}

/**
 * Resend event → Rover event. Only map events that correspond to durable,
 * decision-grade outcomes. `email.delivery_delayed` is intermediate (not a
 * final failure) and `email.complained` is a deliverability signal (not a
 * delivery failure) — both are dropped to keep the event bus signal-dense.
 */
const EVENT_MAP: Record<string, string> = {
	"email.delivered": "mail.delivered",
	"email.bounced": "mail.bounced",
};

/**
 * Turn the configured signing secret into key bytes, or refuse.
 *
 * `Buffer.from(value, "base64")` never fails: it skips whatever it cannot read
 * and hands back whatever is left, so a mistyped secret quietly becomes a
 * short, deterministic key. Nothing then reports a configuration problem —
 * every delivery just fails verification and looks like an attack, which is
 * the one signal this endpoint exists to give.
 */
function decodeSigningSecret(value: string): Buffer {
	const bytes = Buffer.from(value, "base64");
	const normalize = (v: string) => v.replace(/=+$/, "").replace(/\s/g, "");
	if (normalize(bytes.toString("base64")) !== normalize(value)) {
		throw new Error(
			"createResendWebhookHandler: secret is not valid base64. Copy it from the Resend dashboard — it looks like `whsec_<base64>`.",
		);
	}
	if (bytes.length < 16) {
		throw new Error(
			`createResendWebhookHandler: secret decodes to ${bytes.length} bytes, which is too short to sign with. Expected at least 16.`,
		);
	}
	return bytes;
}

export function createResendWebhookHandler(
	options: ResendWebhookOptions,
): WebhookMiddleware {
	if (!options.secret) {
		throw new Error(
			"createResendWebhookHandler: secret is required for HMAC verification.",
		);
	}
	const secretRaw = options.secret.startsWith("whsec_")
		? options.secret.slice(6)
		: options.secret;
	const keyBytes = decodeSigningSecret(secretRaw);
	const emitter = options.emitter;
	const maxAgeSeconds = options.maxAgeSeconds ?? 300;

	return async (ctx: WebhookHttpContext, _next): Promise<void> => {
		const raw = await Promise.resolve(ctx.request.rawBody());
		const id = ctx.request.header("svix-id");
		const timestamp = ctx.request.header("svix-timestamp");
		const signatureHeader = ctx.request.header("svix-signature");
		if (!id || !timestamp || !signatureHeader) {
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

		if (!verifySvixSignature(raw, id, timestamp, signatureHeader, keyBytes)) {
			ctx.response.status(401).json({ error: "invalid_signature" });
			return;
		}

		let payload: ResendPayload;
		try {
			payload = JSON.parse(raw.toString("utf8")) as ResendPayload;
		} catch {
			ctx.response.status(400).json({ error: "invalid_json" });
			return;
		}
		emitMappedEvent(emitter, payload);
		ctx.response.status(200).json({ ok: true });
	};
}

/**
 * Verify a Svix signature header. Svix signs `<id>.<timestamp>.<body>` and emits
 * a space-separated list of `v1,<base64sig>` candidates — accept if any matches
 * (constant-time compare).
 */
function verifySvixSignature(
	raw: Buffer,
	id: string,
	timestamp: string,
	signatureHeader: string,
	keyBytes: Buffer,
): boolean {
	const toSign = Buffer.concat([
		Buffer.from(`${id}.${timestamp}.`, "utf8"),
		raw,
	]);
	const expected = createHmac("sha256", keyBytes)
		.update(toSign)
		.digest("base64");

	for (const part of signatureHeader.split(" ")) {
		const [scheme, sig] = part.split(",");
		if (scheme !== "v1" || !sig) continue;
		const sigBuf = Buffer.from(sig, "base64");
		const expBuf = Buffer.from(expected, "base64");
		if (sigBuf.length !== expBuf.length) continue;
		if (timingSafeEqual(sigBuf, expBuf)) return true;
	}
	return false;
}

/** Map a Resend payload to a mail event and emit it; emitter throws are swallowed. */
function emitMappedEvent(
	emitter: WebhookEmitter,
	payload: ResendPayload,
): void {
	const mapped = payload.type ? EVENT_MAP[payload.type] : undefined;
	if (!mapped) return;
	const to = Array.isArray(payload.data?.to)
		? (payload.data.to[0] ?? "")
		: (payload.data?.to ?? "");
	try {
		emitter.emit(mapped, {
			messageId: payload.data?.email_id ?? "",
			to,
			reason: payload.data?.reason,
			timestamp: parseTimestamp(payload.data?.created_at),
		});
	} catch {
		// Emitter failures must not flip the webhook response; providers will
		// replay on non-2xx and flood the bus.
	}
}
