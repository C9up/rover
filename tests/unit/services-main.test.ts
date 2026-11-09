import { afterEach, describe, expect, it } from "vitest";
import { Mail } from "../../src/Mail.js";
import mail, { clearMail, setMail } from "../../src/services/main.js";

afterEach(() => clearMail());

describe("rover > services/main accessor", () => {
	it("is not thenable before boot, so awaiting it hands back the proxy", async () => {
		await expect(Promise.resolve(mail)).resolves.toBe(mail);
	});

	it("answers undefined to symbol lookups before boot instead of throwing", () => {
		expect(Reflect.get(mail, Symbol.toPrimitive)).toBeUndefined();
		expect(Reflect.get(mail, Symbol.iterator)).toBeUndefined();
		expect(() => String(Object.prototype.toString.call(mail))).not.toThrow();
	});

	it("still reports a genuine member access made before boot", () => {
		expect(() => mail.send).toThrow(/accessed before RoverProvider.boot/);
	});

	it("forwards to the installed Mail once booted", () => {
		const real = new Mail({
			default: "log",
			from: "app@example.com",
			mailers: { log: { transport: "log" } },
		});
		setMail(real);
		expect(mail.use("log").name).toBe("log");
	});
});
