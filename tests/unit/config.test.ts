/**
 * Unit suite for the `defineConfig` helper — it's an identity function used
 * for type inference on `config/mail.ts`, but it still ships in the public
 * surface, so verify the round-trip contract.
 */
import { describe, expect, it } from "vitest";
import { defineConfig, type MailConfig } from "../../src/config.js";

describe("rover > defineConfig", () => {
	it("returns its input unchanged (identity for typed config files)", () => {
		const cfg: MailConfig = {
			default: "log",
			from: "noreply@example.com",
			transports: { log: { transport: "log" } },
		};
		const out = defineConfig(cfg);
		// Same reference — must not clone or mutate.
		expect(out).toBe(cfg);
	});

	it("preserves transport-specific fields verbatim", () => {
		const cfg: MailConfig = {
			default: "smtp",
			from: "noreply@example.com",
			transports: {
				smtp: {
					transport: "smtp",
					host: "mail.example.com",
					port: 587,
				},
			},
		};
		expect(defineConfig(cfg)).toEqual(cfg);
	});
});
