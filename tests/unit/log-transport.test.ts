import { afterEach, describe, expect, it, vi } from "vitest";
import { Mail } from "../../src/index.js";

afterEach(() => vi.restoreAllMocks());

function logged(): string[] {
	const spy = vi.mocked(console.log);
	return spy.mock.calls.map((call) => String(call[0]));
}

function logMail(options: Record<string, unknown> = {}): Mail {
	return new Mail({
		default: "log",
		from: "app@example.com",
		mailers: { log: { transport: "log", ...options } },
	});
}

describe("rover > LogTransport", () => {
	it("keeps the body out of the log by default (reset links, one-time codes)", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await logMail().send((m) =>
			m
				.to("victim@example.com")
				.subject("Reset")
				.text("Your reset link: https://app.example.com/reset?token=SECRET"),
		);
		const out = logged().join("\n");
		expect(out).toContain("victim@example.com");
		expect(out).not.toContain("SECRET");
	});

	it("logs the body only when logBody is set", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await logMail({ logBody: true }).send((m) =>
			m.to("a@example.com").subject("s").text("hello body"),
		);
		expect(logged().join("\n")).toContain("hello body");
	});

	it("cannot be made to forge a second log line through the subject", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await logMail({ logBody: true }).send((m) =>
			m
				.to("victim@example.com")
				.subject("Reset\n[MAIL] To: admin@example.com | Subject: forged")
				.text("line one\nline two\r\n[MAIL] forged"),
		);
		for (const line of logged()) {
			expect(line).not.toMatch(/[\r\n]/);
		}
		expect(logged().filter((l) => l.startsWith("[MAIL]"))).toHaveLength(1);
	});
});
