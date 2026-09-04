/**
 * The `mailFake()` helix plugin (AdonisJS `mail.fake()` parity): the plugin
 * registers a `mail` getter that activates the mailer's fake per test and
 * auto-restores it via `ctx.cleanup`. Verified with a mock mailer + a mock
 * PluginApi/context (no helix runtime needed).
 */

import { createAssert, type TestContext, type TestInstance } from "@c9up/helix";
import { describe, expect, it } from "vitest";
import { FakeMail, mailFake } from "../../src/testing/FakeMail.js";

const stubInstance: TestInstance = {
	title: "t",
	fullName: "t",
	options: {
		title: "t",
		timeout: 0,
		retries: 0,
		tags: [],
		isTodo: false,
		isFailing: false,
		meta: {},
	},
	isPinned: false,
	resetTimeout: () => {},
	cleanup: () => {},
};

describe("helix plugin > mailFake()", () => {
	it("injects a per-test fake and auto-restores the mailer", async () => {
		const fake = new FakeMail();
		let fakeCalls = 0;
		let restoreCalls = 0;
		const mailer = {
			fake: () => {
				fakeCalls += 1;
				return fake;
			},
			restore: () => {
				restoreCalls += 1;
			},
		};

		// Capture the registered getter via a mock PluginApi.
		let getter: ((ctx: TestContext) => unknown) | undefined;
		await mailFake(mailer)({
			context: {
				macro() {},
				getter(name, fn) {
					if (name === "mail") getter = fn;
				},
			},
		});
		expect(getter).toBeDefined();

		// Simulate a test accessing `ctx.mail`: the getter activates the fake and
		// registers a cleanup that restores the mailer.
		const cleanups: Parameters<TestContext["cleanup"]>[0][] = [];
		// `mail` is required on `TestContext` because importing this package
		// augments it — the getter under test is what fills it at run time, so
		// the stub starts from the fake the getter would install.
		const ctx: TestContext = {
			cleanup: (fn) => {
				cleanups.push(fn);
			},
			assert: createAssert(),
			test: stubInstance,
			mail: fake,
		};

		const injected = getter?.(ctx);
		expect(injected).toBe(fake);
		expect(fakeCalls).toBe(1);
		expect(restoreCalls).toBe(0);

		// End of test → cleanups run → mailer restored.
		for (const fn of cleanups) await fn();
		expect(restoreCalls).toBe(1);
	});
});
