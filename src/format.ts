/**
 * Address handling shared by the builder, the manager and the transports. Kept
 * dependency-free and in its own module so both `BaseMail` and
 * `MessageBuilder` can import it without re-introducing the BaseMail ↔
 * MessageBuilder value cycle.
 *
 * Recipients stay structured end to end, as AdonisJS keeps them: a bare
 * address string, or `{ address, name }`. Formatting them into a
 * `"Name" <address>` string and letting the next layer re-parse it is how one
 * `to(email, name)` became several recipients: nodemailer reads such a string
 * as an address LIST.
 */

import { RoverError } from "./RoverError.js";

/** A recipient as AdonisJS stores it: a bare address, or an address and a name. */
export type Recipient = string | { address: string; name: string };

/** CR, LF and NUL — the characters that end a header line or a C string. */
const HEADER_BREAKERS = /[\r\n\0]/;

/** RFC 5322 `specials`: none of them may appear in an unquoted addr-spec. */
const SPECIALS = new Set([...'()<>[]:;@\\,"']);

/**
 * Whether `value` is exactly ONE addr-spec, `local@domain`, with nothing a
 * parser could read as a second address, a display name or a comment.
 *
 * Quoted local parts (`"a b"@example.com`) are refused: they are legal but
 * practically unused, and every provider API re-parses addresses its own way.
 * Non-ASCII is allowed (RFC 6531 / IDN).
 */
export function isAddrSpec(value: string): boolean {
	const at = value.lastIndexOf("@");
	if (at <= 0 || at === value.length - 1) return false;
	for (const char of value.slice(0, at) + value.slice(at + 1)) {
		const code = char.codePointAt(0) ?? 0;
		if (code <= 0x20 || code === 0x7f || SPECIALS.has(char)) return false;
	}
	return true;
}

/** Throw unless `address` is a single, header-safe addr-spec. */
export function assertAddress(address: unknown, what = "address"): string {
	if (typeof address !== "string") {
		throw new RoverError(
			"E_MAIL_INVALID_ADDRESS",
			`The ${what} must be a string, got ${typeof address}.`,
		);
	}
	assertHeaderSafe(address, what);
	if (!isAddrSpec(address)) {
		throw new RoverError(
			"E_MAIL_INVALID_ADDRESS",
			`The ${what} ${JSON.stringify(address)} is not a single email address.`,
			{
				hint: "Pass one address per call (local@domain). Put the display name in the second argument, and call to()/cc()/bcc() once per recipient or with an array.",
			},
		);
	}
	return address;
}

/**
 * Build a recipient from an address and an optional display name. An empty
 * name gives the bare-address form, as upstream does.
 */
export function toRecipient(address: string, name?: string): Recipient {
	assertAddress(address);
	if (name === undefined || name === "") return address;
	if (typeof name !== "string") {
		throw new RoverError(
			"E_MAIL_INVALID_ADDRESS",
			`The display name must be a string, got ${typeof name}.`,
		);
	}
	assertHeaderSafe(name, "name");
	return { address, name };
}

/**
 * Validate a recipient that did not come through the builder — a queue
 * payload, a hand-built `MailMessage`.
 */
export function assertRecipient(value: unknown, what = "recipient"): Recipient {
	if (typeof value === "string") return assertAddress(value, what);
	if (typeof value === "object" && value !== null) {
		const address: unknown = Reflect.get(value, "address");
		const name: unknown = Reflect.get(value, "name");
		if (typeof name !== "string" && name !== undefined) {
			throw new RoverError(
				"E_MAIL_INVALID_ADDRESS",
				`The ${what} name must be a string.`,
			);
		}
		return toRecipient(assertAddress(address, what), name);
	}
	throw new RoverError(
		"E_MAIL_INVALID_ADDRESS",
		`The ${what} must be an address string or { address, name }.`,
	);
}

export function recipientAddress(recipient: Recipient): string {
	return typeof recipient === "string" ? recipient : recipient.address;
}

export function recipientName(recipient: Recipient): string | undefined {
	return typeof recipient === "string" ? undefined : recipient.name;
}

/**
 * The `"Name" <address>` display form, for logs, events and the provider APIs
 * that take one string per mailbox. The name is a quoted-string, so `\` and
 * `"` are escaped; the address was validated as a single addr-spec, so the
 * result parses back to exactly one mailbox.
 */
export function formatRecipient(recipient: Recipient): string {
	if (typeof recipient === "string") return recipient;
	const quoted = recipient.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return `"${quoted}" <${recipient.address}>`;
}

/**
 * Format an address with an optional display name into the `"Name" <address>`
 * form, after the same validation the builder applies.
 *
 * A line break cannot be escaped in a header — it ENDS the header — so a value
 * carrying CR, LF or NUL is rejected rather than mangled. Accepting it is how a
 * contact form turns into an open relay: one `\r\nBcc:` and the message goes
 * wherever the attacker asked.
 */
export function formatAddress(address: string, name?: string): string {
	return formatRecipient(toRecipient(address, name));
}

/** nodemailer's address object, which it never re-splits. */
export function toNodemailerAddress(recipient: Recipient): {
	name: string;
	address: string;
} {
	return {
		name: recipientName(recipient) ?? "",
		address: recipientAddress(recipient),
	};
}

/** The `{ email, name }` contact most provider JSON APIs take. */
export function contactOf(recipient: Recipient): {
	email: string;
	name?: string;
} {
	// Stripped at the wire boundary too: a transport can be handed a message
	// that never went through the builder or the manager's validation.
	const name = recipientName(recipient)?.replace(/[\r\n]/g, "");
	const email = recipientAddress(recipient).replace(/[\r\n]/g, "");
	return name === undefined ? { email } : { email, name };
}

export function assertHeaderSafe(value: string, what: string): void {
	if (!HEADER_BREAKERS.test(value)) return;
	throw new RoverError(
		"E_MAIL_HEADER_INJECTION",
		`The ${what} contains a line break or NUL, which cannot appear in a mail header.`,
		{
			hint: "Strip CR/LF/NUL from user-supplied names and addresses before building the message.",
		},
	);
}
