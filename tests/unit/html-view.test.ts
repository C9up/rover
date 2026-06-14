import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	Mail,
	type MailMessage,
	type MailTransport,
	MessageBuilder,
	registerTransport,
} from "../../src/index.js";
import {
	resetCache,
	setViewsRoot,
} from "../../src/templating/SimpleTemplate.js";

class SpyTransport implements MailTransport {
	sent: MailMessage[] = [];
	async send(message: MailMessage): Promise<void> {
		this.sent.push(message);
	}
}

describe("rover > MessageBuilder.htmlView", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "rover-view-"));
		setViewsRoot(root);
		resetCache();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("renders the template during build() and assigns the result to message.html", async () => {
		writeFileSync(path.join(root, "welcome.html"), "Welcome, {{ user.name }}!");

		const builder = new MessageBuilder();
		builder
			.to("user@example.com")
			.subject("Hi")
			.htmlView("welcome", {
				user: { name: "Ada" },
			});

		const msg = await builder.build();
		expect(msg.html).toBe("Welcome, Ada!");
	});

	it("works end-to-end through Mail.send(callback) with a spy transport", async () => {
		writeFileSync(path.join(root, "welcome.html"), "<p>Hi {{ name }}</p>");
		const spy = new SpyTransport();
		registerTransport("tail-html-view-1", () => spy);
		const mail = new Mail({
			default: "log",
			from: "default@example.com",
			transports: { log: { transport: "tail-html-view-1" } },
		});

		await mail.send((m) =>
			m.to("u@x.com").subject("S").htmlView("welcome", { name: "Lin" }),
		);

		expect(spy.sent).toHaveLength(1);
		expect(spy.sent[0].html).toBe("<p>Hi Lin</p>");
	});

	it("Mail constructor propagates config.viewsRoot to the template engine", async () => {
		writeFileSync(path.join(root, "propagated.html"), "ok {{ x }}");
		const spy = new SpyTransport();
		registerTransport("tail-html-view-2", () => spy);

		// Use a different directory so we can prove the constructor sets it.
		setViewsRoot("/tmp/definitely-wrong");
		new Mail({
			default: "log",
			from: "default@example.com",
			transports: { log: { transport: "tail-html-view-2" } },
			viewsRoot: root,
		});

		const builder = new MessageBuilder();
		builder.to("u@x.com").subject("S").htmlView("propagated", { x: "y" });
		const msg = await builder.build();
		expect(msg.html).toBe("ok y");
	});

	it("two Mail instances with different viewsRoots don't clobber each other", async () => {
		// setViewsRoot is a last-constructor-wins global; before the fix Mail B's
		// construction overwrote Mail A's root, so A's send resolved B's
		// directory (audit 2026-06-13). Each Mail.send must use its OWN root.
		const rootA = mkdtempSync(path.join(tmpdir(), "rover-view-a-"));
		const rootB = mkdtempSync(path.join(tmpdir(), "rover-view-b-"));
		try {
			writeFileSync(path.join(rootA, "tpl.html"), "<p>A:{{ v }}</p>");
			writeFileSync(path.join(rootB, "tpl.html"), "<p>B:{{ v }}</p>");
			const spyA = new SpyTransport();
			const spyB = new SpyTransport();
			registerTransport("tail-iso-a", () => spyA);
			registerTransport("tail-iso-b", () => spyB);

			const mailA = new Mail({
				default: "log",
				from: "a@x.com",
				transports: { log: { transport: "tail-iso-a" } },
				viewsRoot: rootA,
			});
			// Constructing B last points the shared global at rootB — the clash.
			const mailB = new Mail({
				default: "log",
				from: "b@x.com",
				transports: { log: { transport: "tail-iso-b" } },
				viewsRoot: rootB,
			});

			await mailA.send((m) =>
				m.to("u@x.com").subject("S").htmlView("tpl", { v: 1 }),
			);
			await mailB.send((m) =>
				m.to("u@x.com").subject("S").htmlView("tpl", { v: 2 }),
			);

			expect(spyA.sent[0]?.html).toBe("<p>A:1</p>");
			expect(spyB.sent[0]?.html).toBe("<p>B:2</p>");
		} finally {
			rmSync(rootA, { recursive: true, force: true });
			rmSync(rootB, { recursive: true, force: true });
		}
	});
});
