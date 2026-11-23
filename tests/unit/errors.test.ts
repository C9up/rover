import { Exception } from "@c9up/flare";
import { describe, expect, it } from "vitest";
import { errors } from "../../src/index.js";
import { toReamError } from "../../src/templating/loadNapi.js";

describe("rover > errors", () => {
	it("the entry exports every error as one `errors` namespace", () => {
		const error = new errors.E_MAIL_UNKNOWN_TRANSPORT(["smpt", "primary"]);
		expect(error).toBeInstanceOf(Exception);
		expect(error).toBeInstanceOf(errors.E_MAIL_UNKNOWN_TRANSPORT);
		expect(error.code).toBe("E_MAIL_UNKNOWN_TRANSPORT");
		expect(error.status).toBe(500);
		expect(error.message).toBe(
			"Unknown mail transport type 'smpt' (configured under name 'primary')",
		);
	});

	it("a transport failure carries its context and its help", () => {
		const cause = new Error("socket hang up");
		const error = new errors.E_MAIL_TRANSPORT_ERROR("smtp failed", {
			context: {
				provider: "smtp",
				upstreamStatus: "0",
				networkCode: "ECONNRESET",
			},
			help: "Retry later.",
			cause,
		});
		expect(error).toBeInstanceOf(Exception);
		expect(error.name).toBe("EmailTransportException");
		expect(error.code).toBe("E_MAIL_TRANSPORT_ERROR");
		expect(error.status).toBe(500);
		expect(error.context.networkCode).toBe("ECONNRESET");
		expect(error.help).toBe("Retry later.");
		expect(error.cause).toBe(cause);
	});

	it("keeps the mail library's construction: a message and { cause }", () => {
		const cause = new Error("ECONNREFUSED");
		const transport = new errors.E_MAIL_TRANSPORT_ERROR(
			"Unable to send email using the smtp transport",
			{ cause },
		);
		expect(transport.cause).toBe(cause);
		expect(transport.context).toEqual({});

		const config = new errors.E_INVALID_CONFIG(
			'Invalid config for "resend" transport. The "apiKey" property is missing',
		);
		expect(config).toBeInstanceOf(Exception);
		expect(config).toMatchObject({
			name: "InvalidConfigException",
			code: "E_INVALID_CONFIG",
			status: 500,
		});
	});

	it("a missing config says how to add one", () => {
		const error = new errors.E_MAIL_CONFIG_MISSING();
		expect(error.code).toBe("E_MAIL_CONFIG_MISSING");
		expect(error.help).toMatch(/defineConfig/);
	});

	it("maps the native engine's coded envelope to the matching class, the native error as cause", () => {
		const native = new Error(
			JSON.stringify({
				code: "E_MAIL_TEMPLATE_RECURSION",
				message: "partial a includes itself",
			}),
		);
		const error = toReamError(native);
		expect(error).toBeInstanceOf(errors.E_MAIL_TEMPLATE_RECURSION);
		expect(error.message).toBe("partial a includes itself");
		expect(error.cause).toBe(native);
		expect(error.help).toMatch(/Break the cycle/);
	});

	it("wraps a native error without a code as a syntax error", () => {
		const native = new Error("boom");
		const error = toReamError(native);
		expect(error).toBeInstanceOf(errors.E_MAIL_TEMPLATE_SYNTAX);
		expect(error.cause).toBe(native);
	});
});
