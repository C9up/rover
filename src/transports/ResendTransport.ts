import { Buffer } from "node:buffer";
import { ReamError } from "@c9up/ream";
import {
	type MailMessage,
	type MailSendOutcome,
	type MailTransport,
	registerTransport,
} from "../Mail.js";
import { wrapFetchNetworkError } from "./fetchError.js";

const stripCrlf = (v: string): string => v.replace(/[\r\n]/g, "");
const normalizeConfig = (v: string): string => stripCrlf(v).trim();
const MAX_PROVIDER_MESSAGE = 16 * 1024;
const capMessage = (s: string): string =>
	s.length <= MAX_PROVIDER_MESSAGE
		? s
		: `${s.slice(0, MAX_PROVIDER_MESSAGE)}...[truncated]`;
/** Redact Basic/Bearer tokens if the upstream echoes our own request headers. */
const redactSecrets = (s: string): string =>
	s
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
		.replace(/Basic\s+[A-Za-z0-9+/=]+/g, "Basic [REDACTED]");

interface ResendBody {
	from: string;
	to: string[];
	cc?: string[];
	bcc?: string[];
	reply_to?: string;
	subject: string;
	html?: string;
	text?: string;
	attachments?: Array<{
		filename: string;
		content: string;
		content_type?: string;
	}>;
	headers?: Record<string, string>;
}

export class ResendTransport implements MailTransport {
	#apiKey: string;

	constructor(config: Record<string, unknown>) {
		const apiKey =
			typeof config.apiKey === "string" ? normalizeConfig(config.apiKey) : "";
		if (!apiKey) {
			throw new ReamError(
				"MAIL_PROVIDER_CONFIG",
				"Resend transport requires apiKey",
				{ hint: "Set { apiKey } in your mail config." },
			);
		}
		this.#apiKey = apiKey;
	}

	async send(message: MailMessage): Promise<MailSendOutcome> {
		if (
			message.to.length === 0 &&
			message.cc.length === 0 &&
			message.bcc.length === 0
		) {
			throw new ReamError(
				"MAIL_PROVIDER_CONFIG",
				"Mail message has no recipients",
				{ hint: "Set at least one `to`, `cc`, or `bcc` before sending." },
			);
		}
		const body: ResendBody = {
			from: stripCrlf(message.from),
			to: message.to.map(stripCrlf),
			subject: stripCrlf(message.subject),
		};
		if (message.cc.length) body.cc = message.cc.map(stripCrlf);
		if (message.bcc.length) body.bcc = message.bcc.map(stripCrlf);
		if (message.replyTo) body.reply_to = stripCrlf(message.replyTo);
		if (message.html) body.html = message.html;
		if (message.text) body.text = message.text;
		if (message.attachments.length > 0) {
			body.attachments = message.attachments.map((att) => {
				const buf = Buffer.from(att.content as Buffer | string);
				return {
					filename: stripCrlf(att.filename),
					content: buf.toString("base64"),
					content_type: att.contentType
						? stripCrlf(att.contentType)
						: undefined,
				};
			});
		}
		const customHeaders = Object.entries(message.headers);
		if (customHeaders.length > 0) {
			body.headers = {};
			for (const [k, v] of customHeaders) {
				body.headers[stripCrlf(k)] = stripCrlf(v);
			}
		}

		// fetch() rejections (DNS / TCP / TLS / socket reset) bypass the
		// !res.ok branch entirely. Wrap them so retry classification can
		// pick up the underlying errno (top-level `.code` for legacy
		// shims, `.cause.code` for Node's built-in undici).
		let res: Response;
		try {
			res = await fetch("https://api.resend.com/emails", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.#apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});
		} catch (err) {
			throw wrapFetchNetworkError("resend", err);
		}
		if (!res.ok) {
			const providerMessage = redactSecrets(capMessage(await res.text()));
			const retryAfter = res.headers.get("retry-after") ?? undefined;
			const ctx: Record<string, string> = {
				provider: "resend",
				upstreamStatus: String(res.status),
				providerMessage,
			};
			if (retryAfter) ctx.retryAfter = retryAfter;
			throw new ReamError(
				"MAIL_PROVIDER_ERROR",
				`Resend returned ${res.status}`,
				{
					hint: "Inspect `context.upstreamStatus` to decide retry eligibility. `context.retryAfter` (when set) carries the provider's backoff hint in seconds.",
					context: ctx,
				},
			);
		}
		// Success: Resend returns `{ id: "<uuid>" }` per API docs.
		try {
			const body = (await res.json()) as { id?: string };
			if (typeof body.id === "string" && body.id.length > 0) {
				return { providerId: body.id };
			}
		} catch {
			// Empty body or non-JSON — fall back to generated id.
		}
		return;
	}
}

registerTransport("resend", (config) => new ResendTransport(config));
