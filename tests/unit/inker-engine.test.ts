import { afterEach, describe, expect, it, vi } from "vitest";

/** The slice of a ream app RoverProvider reads, with a log-only mail config. */
function app(usingInker: boolean | undefined) {
	const singletons = new Map<unknown, () => unknown>();
	const resolved = new Map<unknown, unknown>();
	return {
		usingInker,
		container: {
			singleton(token: unknown, factory: () => unknown) {
				singletons.set(token, factory);
			},
			has: () => false,
			async resolve<T>(token: unknown): Promise<T> {
				if (!resolved.has(token)) {
					resolved.set(token, await singletons.get(token)?.());
				}
				// Reflect.apply hands back the stored value untyped, which is
				// what a container's generic resolve() promises its caller.
				const value: T = Reflect.apply(Map.prototype.get, resolved, [token]);
				return value;
			},
		},
		config: {
			get: <T>(key: string): T | undefined => {
				const config: T | undefined =
					key === "mail"
						? Object.assign(Object.create(null), {
								default: "log",
								from: "app@example.com",
								mailers: { log: { transport: "log" } },
							})
						: undefined;
				return config;
			},
		},
	};
}

async function bootWith(usingInker: boolean | undefined) {
	const { default: RoverProvider } = await import("../../src/RoverProvider.js");
	const { MessageBuilder } = await import("../../src/MessageBuilder.js");
	const provider = new RoverProvider(app(usingInker));
	provider.register();
	await provider.boot();
	return { provider, MessageBuilder };
}

afterEach(() => {
	vi.doUnmock("@c9up/inker");
	vi.resetModules();
});

describe("rover > inker renders mail views when the app uses it", () => {
	it("registers inker's share().render() as the template engine", async () => {
		const calls: unknown[] = [];
		vi.doMock("@c9up/inker", () => ({
			default: {
				share(state: Record<string, unknown>) {
					return {
						render: async (template: string, data: Record<string, unknown>) => {
							calls.push({ template, state, data });
							return `<p>${template}</p>`;
						},
					};
				},
			},
		}));
		const { provider, MessageBuilder } = await bootWith(true);
		const html = await new MessageBuilder()
			.to("a@example.com")
			.htmlView("emails/welcome", { user: "Ada" })
			.build(undefined, { brandName: "Acme" });

		expect(html.html).toBe("<p>emails/welcome</p>");
		expect(calls).toMatchObject([
			{
				template: "emails/welcome",
				state: { brandName: "Acme" },
				data: { user: "Ada" },
			},
		]);
		await provider.shutdown();
		expect(MessageBuilder.templateEngine).toBeUndefined();
	});

	it("leaves the built-in engine alone when the app does not use inker", async () => {
		vi.doMock("@c9up/inker", () => {
			throw new Error("must not be imported");
		});
		const { MessageBuilder } = await bootWith(undefined);
		expect(MessageBuilder.templateEngine).toBeUndefined();
	});

	it("refuses to boot with an inker module it cannot render through", async () => {
		vi.doMock("@c9up/inker", () => ({ default: { render: () => "" } }));
		await expect(bootWith(true)).rejects.toMatchObject({
			code: "E_MAIL_TEMPLATE_ENGINE",
		});
	});

	it("reports a share() that hands back no renderer", async () => {
		vi.doMock("@c9up/inker", () => ({
			default: { share: () => ({}) },
		}));
		const { MessageBuilder } = await bootWith(true);
		await expect(
			new MessageBuilder().to("a@example.com").htmlView("x").build(),
		).rejects.toMatchObject({ code: "E_MAIL_TEMPLATE_ENGINE" });
	});
});
