/**
 * Shared address formatting helper. Kept dependency-free and in its own module
 * so both `BaseMail` and `MessageBuilder` can import it without re-introducing
 * the BaseMail ↔ MessageBuilder value cycle.
 */

import { RoverError } from "./RoverError.js";

/** CR, LF and NUL — the characters that end a header line or a C string. */
const HEADER_BREAKERS = /[\r\n\0]/;

/**
 * Format a recipient address with an optional display name into the
 * `"Name" <address>` form (RFC 5322 quoted display name). A bare address —
 * or an empty/whitespace-only name — is returned unchanged.
 *
 * The display name is a QUOTED string, so a `"` inside it would close the quote
 * early: a name of `x" <evil@example.com>, "y` would otherwise forge a second
 * recipient. Backslash and quote are escaped, which is what a quoted-string
 * allows.
 *
 * A line break cannot be escaped in a header — it ENDS the header — so a value
 * carrying CR, LF or NUL is rejected rather than mangled. Accepting it is how a
 * contact form turns into an open relay: one `\r\nBcc:` and the message goes
 * wherever the attacker asked.
 */
export function formatAddress(address: string, name?: string): string {
	assertHeaderSafe(address, "address");
	if (name === undefined || name === "") return address;
	assertHeaderSafe(name, "name");
	// Escape the escape character first, or a trailing backslash would swallow
	// the closing quote.
	const quoted = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return `"${quoted}" <${address}>`;
}

function assertHeaderSafe(value: string, what: string): void {
	if (!HEADER_BREAKERS.test(value)) return;
	throw new RoverError(
		"MAIL_HEADER_INJECTION",
		`The ${what} contains a line break or NUL, which cannot appear in a mail header.`,
		{
			hint: "Strip CR/LF/NUL from user-supplied names and addresses before building the message.",
		},
	);
}
