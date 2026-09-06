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
	/**
	 * Tokens that ARE bound but whose factory fails — a bad queue config, a
	 * driver that cannot connect. Distinct from simply not being bound, which
	 * is what `has()` answers, and the distinction is the point: rover used to
	 * read both as "the optional peer is not installed".
	 */
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
		has(key: unknown): boolean {
			if (typeof key === "string" && throwOn.has(key)) return true;
			if (typeof key === "string" && key in tokens) return true;
			return bindings.has(key) || singletons.has(key);
		},
		async resolve<T>(key: unknown): Promise<T> {
			if (typeof key === "string" && throwOn.has(key)) {
				throw new Error(`unbound: ${key}`);
			}
			if (typeof key === "string" && key in tokens) {
				return tokens[key] as T;
			}
			if (singletons.has(key)) return singletons.get(key) as T;
			const factory = bindings.get(key);
			if (!factory) throw new Error(`unbound: ${String(key)}`);
			const instance = await factory();
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
	it("binds Mail as a singleton resolvable from the container", async () => {
		const app = makeApp({
			mailConfig: {
				default: "log",
				from: "test@example.com",
				transports: { log: { transport: "log" } },
			},
		});
		const provider = new RoverProvider(app);
		provider.register();
		const mail = await app.container.resolve<Mail>(Mail);
		expect(mail).toBeInstanceOf(Mail);
		// Second resolve must return the same instance (singleton contract).
		expect(await app.container.resolve<Mail>(Mail)).toBe(mail);
	});

	it('binds the string alias "mail" → same Mail instance', async () => {
		const app = makeApp({
			mailConfig: {
				default: "log",
				from: "test@example.com",
				transports: { log: { transport: "log" } },
			},
		});
		new RoverProvider(app).register();
		const byClass = await app.container.resolve<Mail>(Mail);
		const byAlias = await app.container.resolve<Mail>("mail");
		expect(byAlias).toBe(byClass);
	});

	it("falls back to a default log transport when no mail config is registered", async () => {
		const app = makeApp({
			mailConfig: undefined,
		});
		new RoverProvider(app).register();
		const mail = await app.container.resolve<Mail>(Mail);
		// The fallback default is `log`, `from: noreply@localhost`. We don't
		// reach into Mail internals — just prove it constructs successfully.
		expect(mail).toBeInstanceOf(Mail);
	});

	it("wires optional QueueManager / Emitter when registered in the container", async () => {
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
		const mail = await app.container.resolve<Mail>(Mail);
		expect(mail).toBeInstanceOf(Mail);
	});

	it("builds without the optional peers when they are not bound", async () => {
		const app = makeApp({
			mailConfig: {
				default: "log",
				from: "test@example.com",
				transports: { log: { transport: "log" } },
			},
		});
		new RoverProvider(app).register();
		await expect(app.container.resolve<Mail>(Mail)).resolves.toBeInstanceOf(
			Mail,
		);
	});

	it("surfaces a bound peer whose factory fails, instead of reading it as absent", async () => {
		// The distinction that was missing. Catching everything meant a queue
		// that IS registered but cannot construct — a bad config, a driver that
		// will not connect — looked exactly like "bay is not installed": rover
		// disabled the feature silently and mail queued nowhere.
		const app = makeApp({
			mailConfig: {
				default: "log",
				from: "test@example.com",
				transports: { log: { transport: "log" } },
			},
			throwOnResolve: ["QueueManager"],
		});
		new RoverProvider(app).register();
		await expect(app.container.resolve<Mail>(Mail)).rejects.toThrow(
			/QueueManager/,
		);
	});
});

describe("rover > RoverProvider > shutdown", () => {
	it("releases the services/main singleton it installed", async () => {
		const { getMail } = await import("../../src/services/main.js");
		const app = makeApp({
			mailConfig: {
				default: "log",
				from: "test@example.com",
				transports: { log: { transport: "log" } },
			},
		});
		const provider = new RoverProvider(app);
		provider.register();
		await provider.boot();
		expect(getMail()).toBeInstanceOf(Mail);

		await provider.shutdown();

		// A stopped application left a dead Mail reachable through
		// `import mail from '@c9up/rover/services/main'`.
		expect(getMail()).toBeUndefined();
	});

	it("leaves a binding another application has since installed alone", async () => {
		const { getMail, setMail } = await import("../../src/services/main.js");
		const app = makeApp({
			mailConfig: {
				default: "log",
				from: "test@example.com",
				transports: { log: { transport: "log" } },
			},
		});
		const provider = new RoverProvider(app);
		provider.register();
		await provider.boot();

		// A second application boots in the same process and takes the singleton
		// over — two Ignitors in one test run is the ordinary case.
		const newer = new Mail({
			default: "log",
			from: "other@example.com",
			transports: { log: { transport: "log" } },
		});
		setMail(newer);

		await provider.shutdown();

		// The older application must not clear what the newer one bound —
		// otherwise the survivor's `services/main` throws "accessed before boot".
		expect(getMail()).toBe(newer);
	});
});
