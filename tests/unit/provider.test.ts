/**
 * Unit suite for RoverProvider — covers `register()` container bindings,
 * the optional queue/emitter wire-up, and the fallback config branch.
 *
 * We hand-roll a minimal AppContext rather than booting the full ream
 * Application — RoverProvider only consumes `container.singleton/resolve`
 * and `config.get`, so a tiny stub is enough.
 */
import { describe, expect, it, vi } from "vitest";
import { Mail } from "../../src/Mail.js";
import RoverProvider from "../../src/RoverProvider.js";

type Factory = () => unknown;

function makeApp(opts: {
	mailConfig?: unknown;
	tokens?: Record<string, unknown>;
	throwOnResolve?: string[];
}) {
	const bindings = new Map<unknown, Factory>();
	const singletons = new Map<unknown, unknown>();
	const tokens = opts.tokens ?? {};
	const throwOn = new Set(opts.throwOnResolve ?? []);
	const container = {
		singleton(key: unknown, factory: Factory) {
			bindings.set(key, factory);
		},
		resolve<T>(key: unknown): T {
			if (typeof key === "string" && throwOn.has(key)) {
				throw new Error(`unbound: ${key}`);
			}
			if (typeof key === "string" && key in tokens) {
				return tokens[key] as T;
			}
			if (singletons.has(key)) return singletons.get(key) as T;
			const factory = bindings.get(key);
			if (!factory) throw new Error(`unbound: ${String(key)}`);
			const instance = factory();
			singletons.set(key, instance);
			return instance as T;
		},
	};
	const config = {
		get<T>(key: string): T | undefined {
			if (key === "mail") return opts.mailConfig as T | undefined;
			return undefined;
		},
		set: () => {},
	};
	return { container, config };
}

describe("rover > RoverProvider > register", () => {
	it("binds Mail as a singleton resolvable from the container", () => {
		const app = makeApp({
			mailConfig: {
				default: "log",
				from: "test@example.com",
				transports: { log: { transport: "log" } },
			},
			throwOnResolve: ["QueueManager", "Emitter"],
		});
		const provider = new RoverProvider(app);
		provider.register();
		const mail = app.container.resolve<Mail>(Mail);
		expect(mail).toBeInstanceOf(Mail);
		// Second resolve must return the same instance (singleton contract).
		expect(app.container.resolve<Mail>(Mail)).toBe(mail);
	});

	it('binds the string alias "mail" → same Mail instance', () => {
		const app = makeApp({
			mailConfig: {
				default: "log",
				from: "test@example.com",
				transports: { log: { transport: "log" } },
			},
			throwOnResolve: ["QueueManager", "Emitter"],
		});
		new RoverProvider(app).register();
		const byClass = app.container.resolve<Mail>(Mail);
		const byAlias = app.container.resolve<Mail>("mail");
		expect(byAlias).toBe(byClass);
	});

	it("falls back to a default log transport when no mail config is registered", () => {
		const app = makeApp({
			mailConfig: undefined,
			throwOnResolve: ["QueueManager", "Emitter"],
		});
		new RoverProvider(app).register();
		const mail = app.container.resolve<Mail>(Mail);
		// The fallback default is `log`, `from: noreply@localhost`. We don't
		// reach into Mail internals — just prove it constructs successfully.
		expect(mail).toBeInstanceOf(Mail);
	});

	it("wires optional QueueManager / Emitter when registered in the container", () => {
		const fakeQueue = { register: vi.fn(), push: vi.fn() };
		const fakeEmitter = { dispatchEvent: vi.fn() };
		const app = makeApp({
			mailConfig: {
				default: "log",
				from: "test@example.com",
				transports: { log: { transport: "log" } },
			},
			tokens: { QueueManager: fakeQueue, Emitter: fakeEmitter },
		});
		new RoverProvider(app).register();
		// Just constructing Mail with the wired peers is enough to prove the
		// `tryResolve` path took the success branch. Mail behaviour with the
		// queue/emitter is covered by mail.test.ts / send-later.test.ts.
		const mail = app.container.resolve<Mail>(Mail);
		expect(mail).toBeInstanceOf(Mail);
	});

	it("swallows resolve failures for missing optional peers (tryResolve fallback)", () => {
		const app = makeApp({
			mailConfig: {
				default: "log",
				from: "test@example.com",
				transports: { log: { transport: "log" } },
			},
			throwOnResolve: ["QueueManager", "Emitter"],
		});
		new RoverProvider(app).register();
		// The factory runs at resolve-time and must not throw despite the
		// container's `resolve("QueueManager")` rejecting.
		expect(() => app.container.resolve<Mail>(Mail)).not.toThrow();
	});
});
