/**
 * One message → nodemailer, shared by every transport that needs a real MIME
 * message: SMTP hands the options to its SMTP client, and the raw-MIME provider
 * endpoints (Mailgun `messages.mime`, SparkPost `email_rfc822`, SES
 * `SendRawEmail`) get the bytes nodemailer composes from them — structured
 * addresses, encoded-words, transfer encodings, inline parts, threading
 * headers, `List-*` — instead of a second, hand-written MIME builder.
 */

import nodemailer, { type Transport } from "nodemailer";
import type Mail from "nodemailer/lib/mailer/index.js";
import { recipientAddress, toNodemailerAddress } from "./format.js";
import {
	type MailMessage,
	withCanonicalLineEndings,
} from "./MessageBuilder.js";

/** Who the servers are told the message is from and to (MAIL FROM / RCPT TO). */
export interface MailResponseEnvelope {
	from: string | false;
	to: string[];
}

/** The nodemailer mail options a message stands for. */
export function nodemailerOptions(message: MailMessage): Mail.Options {
	return {
		// Address objects, which nodemailer never re-splits: a string would be
		// parsed as an address list.
		from: toNodemailerAddress(message.from),
		to: message.to.map(toNodemailerAddress),
		cc: message.cc.length ? message.cc.map(toNodemailerAddress) : undefined,
		bcc: message.bcc.length ? message.bcc.map(toNodemailerAddress) : undefined,
		replyTo: message.replyTo?.length
			? message.replyTo.map(toNodemailerAddress)
			: undefined,
		subject: message.subject,
		html: message.html,
		text: message.text,
		// nodemailer reads `watchHtml`; there is no bare `watch` field in its
		// mail composer.
		watchHtml: message.watchHtml,
		// MAIL FROM / RCPT TO, when they differ from the headers. Resolved
		// here: given only a bounce address, nodemailer would send to nobody.
		envelope: message.envelope ? smtpEnvelope(message) : undefined,
		priority: message.priority,
		messageId: message.messageId,
		inReplyTo: message.inReplyTo,
		references: message.references,
		headers: Object.keys(message.headers).length ? message.headers : undefined,
		encoding: message.encoding,
		// nodemailer renders `List-*` itself: brackets the URLs, escapes and
		// encodes the comments, folds the line.
		list: message.list,
		icalEvent: message.icalEvent,
		attachments: message.attachments.length
			? message.attachments.map((att) => ({
					filename: att.filename,
					content: att.content,
					contentType: att.contentType,
					cid: att.cid,
					contentDisposition: att.contentDisposition,
					encoding: att.encoding,
					headers: att.headers,
				}))
			: undefined,
	};
}

/**
 * The envelope a message will be sent with: its explicit `envelope()` when
 * set, otherwise the sender and every recipient, as nodemailer derives it.
 */
export function envelopeOf(message: MailMessage): MailResponseEnvelope {
	const explicit = message.envelope;
	const list = (value: string | string[] | undefined): string[] =>
		value === undefined ? [] : Array.isArray(value) ? value : [value];
	if (explicit !== undefined) {
		const to = [
			...list(explicit.to),
			...list(explicit.cc),
			...list(explicit.bcc),
		];
		return {
			from: explicit.from ?? recipientAddress(message.from),
			to:
				to.length > 0
					? to
					: [...message.to, ...message.cc, ...message.bcc].map(
							recipientAddress,
						),
		};
	}
	return {
		from: recipientAddress(message.from),
		to: [...message.to, ...message.cc, ...message.bcc].map(recipientAddress),
	};
}

function smtpEnvelope(message: MailMessage): { from?: string; to: string[] } {
	const { from, to } = envelopeOf(message);
	return from === false ? { to } : { from, to };
}

/** A message composed by nodemailer, ready for a raw-MIME endpoint. */
export interface ComposedMime {
	/** The RFC 5322 bytes, CRLF line ends, Bcc left out. */
	raw: Buffer;
	/** The Message-ID nodemailer wrote, angle brackets included. */
	messageId: string;
	envelope: MailResponseEnvelope;
}

/**
 * Compose `message` exactly as the SMTP transport would put it on the wire,
 * through nodemailer's own pipeline (a capturing transport in place of the
 * SMTP client, as the upstream API transports do).
 */
export async function composeMime(message: MailMessage): Promise<ComposedMime> {
	let composed: ComposedMime | undefined;
	const capture: Transport<undefined> = {
		name: "rover-mime",
		version: "1.0.0",
		send(mail, callback) {
			const node = mail.message;
			if (node === null) {
				callback(new Error("nodemailer composed no message"), undefined);
				return;
			}
			node.build().then(
				(raw) => {
					composed = {
						raw,
						messageId: node.messageId(),
						envelope: node.getEnvelope(),
					};
					callback(null, undefined);
				},
				(err: Error) => callback(err, undefined),
			);
		},
	};
	await nodemailer
		.createTransport(capture)
		.sendMail(nodemailerOptions(withCanonicalLineEndings(message)));
	if (composed === undefined) {
		throw new Error("nodemailer finished without composing the message");
	}
	return composed;
}
