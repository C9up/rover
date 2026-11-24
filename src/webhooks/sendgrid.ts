import { Buffer } from "node:buffer";
import { createPublicKey, type KeyObject, verify } from "node:crypto";
import { emitSafely } from "../emitSafely.js";
import {
	E_ROVER_WEBHOOK_INVALID_KEY,
	E_ROVER_WEBHOOK_KEY_MISSING,
} from "../errors.js";
import { numberField, stringField } from "../guards.js";
import type {
	WebhookEmitter,
	WebhookHttpContext,
	WebhookMiddleware,
} from "./context.js";

export interface SendGridWebhookOptions {
	/**
	 * The verification key of the signed event webhook, as the SendGrid
	 * dashboard shows it: an ECDSA public key on P-256, base64 DER or PEM.
	 * SendGrid signs the timestamp then the body with ECDSA over SHA-256.
	 */
	publicKey: string;
	emitter: WebhookEmitter;
	/**
	 * Maximum age in seconds for a signed payload (default 300 = 5 minutes).
	 * Set to `Number.POSITIVE_INFINITY` to disable (not recommended).
	 */
	maxAgeSeconds?: number;
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
		throw new E_ROVER_WEBHOOK_KEY_MISSING([
			"createSendGridWebhookHandler",
			"publicKey",
			"ECDSA P-256",
		]);
	}
	const key = sendGridKey(options.publicKey);
	const emitter = options.emitter;
	const maxAgeSeconds = options.maxAgeSeconds ?? 300;

	return async (ctx: WebhookHttpContext): Promise<void> => {
		const raw = ctx.request.rawBuffer();
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
		if (!verifies(payloadToVerify, key, sigBytes)) {
			ctx.response.status(401).json({ error: "invalid_signature" });
			return;
		}

		let events: unknown;
		try {
			events = JSON.parse(raw.toString("utf8"));
		} catch {
			ctx.response.status(400).json({ error: "invalid_json" });
			return;
		}
		if (!Array.isArray(events)) {
			ctx.response.status(400).json({ error: "expected_event_array" });
			return;
		}
		for (const ev of events) {
			const event = stringField(ev, "event");
			if (!event) continue;
			const mapped = EVENT_MAP[event];
			if (!mapped) continue;
			try {
				emitSafely(emitter, mapped, {
					messageId: stringField(ev, "sg_message_id") ?? "",
					to: stringField(ev, "email") ?? "",
					reason: stringField(ev, "reason"),
					timestamp: normaliseTimestamp(numberField(ev, "timestamp")),
				});
			} catch {
				// Never let emitter failures flip the webhook response.
			}
		}
		ctx.response.status(200).json({ ok: true });
	};
}

/**
 * The configured key, refused unless it is what SendGrid issues: an EC key
 * on P-256. The digest is stated at verification, not left to the key type.
 */
function sendGridKey(publicKey: string): KeyObject {
	let key: KeyObject;
	try {
		key = createPublicKey(toPem(publicKey));
	} catch (error) {
		throw new E_ROVER_WEBHOOK_INVALID_KEY(
			[
				"publicKey is not a public key in base64 DER or PEM. Copy the verification key from the SendGrid dashboard.",
			],
			{ cause: error },
		);
	}
	const curve = key.asymmetricKeyDetails?.namedCurve;
	if (key.asymmetricKeyType !== "ec" || curve !== "prime256v1") {
		const found =
			key.asymmetricKeyType === "ec"
				? `an EC key on ${curve ?? "an unnamed curve"}`
				: `a key of type ${key.asymmetricKeyType ?? "unknown"}`;
		throw new E_ROVER_WEBHOOK_INVALID_KEY([
			`publicKey is ${found}; SendGrid signs its event webhook with ECDSA on P-256 (prime256v1). Copy the verification key from the SendGrid dashboard.`,
		]);
	}
	return key;
}

/** ECDSA over SHA-256, the DER signature SendGrid sends; a malformed one is a mismatch. */
function verifies(payload: Buffer, key: KeyObject, signature: Buffer): boolean {
	try {
		return verify("sha256", payload, key, signature);
	} catch {
		return false;
	}
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
