/**
 * Shared address formatting helper. Kept dependency-free and in its own module
 * so both `BaseMail` and `MessageBuilder` can import it without re-introducing
 * the BaseMail ↔ MessageBuilder value cycle.
 */

/**
 * Format a recipient address with an optional display name into the
 * `"Name" <address>` form (RFC 5322 quoted display name). A bare address —
 * or an empty/whitespace-only name — is returned unchanged.
 */
export function formatAddress(address: string, name?: string): string {
	return name !== undefined && name !== "" ? `"${name}" <${address}>` : address;
}
