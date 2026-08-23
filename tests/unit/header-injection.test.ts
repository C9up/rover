/**
 * A display name goes into a quoted header field. Interpolating it raw let a
 * `"` close the quote early — forging a recipient — and a CRLF end the header
 * outright, which turns a contact form into an open relay.
 */
import { describe, expect, it } from "vitest";
import { formatAddress } from "../../src/format.js";
import { MessageBuilder } from "../../src/MessageBuilder.js";

describe("rover > header injection", () => {
	it("escapes a quote instead of letting it close the field", () => {
		const out = formatAddress("ada@acme.test", 'x" <evil@attacker.test>, "y');
		expect(out).toBe('"x\\" <evil@attacker.test>, \\"y" <ada@acme.test>');
		// One address, not two.
		expect(out.match(/</g)).toHaveLength(2);
		expect(out.endsWith("<ada@acme.test>")).toBe(true);
	});

	it("escapes the escape character first", () => {
		expect(formatAddress("a@b.test", "back\\slash")).toBe(
			'"back\\\\slash" <a@b.test>',
		);
		// A trailing backslash must not swallow the closing quote.
		expect(formatAddress("a@b.test", "trailing\\")).toBe(
			'"trailing\\\\" <a@b.test>',
		);
	});

	it("rejects a line break rather than mangling it", () => {
		expect(() =>
			formatAddress("a@b.test", "Ada\r\nBcc: evil@attacker.test"),
		).toThrow(/line break or NUL/);
		expect(() => formatAddress("a@b.test\nBcc: evil@attacker.test")).toThrow(
			/line break or NUL/,
		);
		expect(() => formatAddress("a@b.test", "Ada\0")).toThrow(
			/line break or NUL/,
		);
	});

	it("leaves an ordinary address and name alone", () => {
		expect(formatAddress("ada@acme.test")).toBe("ada@acme.test");
		expect(formatAddress("ada@acme.test", "Ada Lovelace")).toBe(
			'"Ada Lovelace" <ada@acme.test>',
		);
	});

	it("stops an injected recipient at the builder too", () => {
		expect(() =>
			new MessageBuilder().to("a@b.test", "Ada\r\nBcc: evil@attacker.test"),
		).toThrow(/line break or NUL/);
	});
});
