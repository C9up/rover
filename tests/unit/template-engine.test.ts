import { afterEach, describe, expect, it } from "vitest";
import {
	Mail,
	type MailMessage,
	type MailTransport,
	MessageBuilder,
	registerTransport,
	type TemplateEngine,
} from "../../src/index.js";

afterEach(() => {
	MessageBuilder.templateEngine = undefined;
});

interface Call {
	template: string;
	shared: Record<string, unknown>;
	data: Record<string, unknown>;
}

/** An engine that records its calls and runs the embed helpers it is given. */
function recordingEngine(calls: Call[]): TemplateEngine {
	return {
		render(template, shared, data) {
			calls.push({ template, shared, data });
			const embed = shared.embedImage;
			const embedData = shared.embedImageData;
			if (template === "html" && typeof embed === "function") {
				return `<img src="${embed("/nonexistent-but-unread/logo.png")}">`;
			}
			if (template === "watch" && typeof embedData === "function") {
				return `<img src="${embedData(Buffer.from("PNG"), { filename: "x.png" })}">`;
			}
			return `rendered ${template}`;
		},
	};
}

describe("rover > a pluggable template engine (AdonisJS Message.templateEngine)", () => {
	it("renders html/text/watch views with (template, sharedState, data)", async () => {
		const calls: Call[] = [];
		let sent: MailMessage | undefined;
		const transport: MailTransport = {
			async send(message) {
				sent = message;
				return undefined;
			},
		};
		registerTransport("engine-spy", () => transport);
		const mail = new Mail({
			default: "spy",
			from: "app@example.com",
			globals: { brandName: "Acme" },
			mailers: { spy: { transport: "engine-spy" } },
		});
		MessageBuilder.templateEngine = {
			render(template, shared, data) {
				calls.push({ template, shared, data });
				const embedData = shared.embedImageData;
				return typeof embedData === "function" && template !== "text"
					? `<img src="${embedData(Buffer.from("PNG"))}">`
					: `rendered ${template}`;
			},
		};
		await mail.send((m) =>
			m
				.to("bob@example.com")
				.subject("s")
				.htmlView("html", { user: "Bob" })
				.textView("text", { user: "Bob" })
				.watchView("watch", { user: "Bob" }),
		);

		expect(calls.map((c) => c.template)).toEqual(["html", "watch", "text"]);
		expect(calls[0]?.data).toEqual({ user: "Bob" });
		expect(calls[0]?.shared.brandName).toBe("Acme");
		// Image helpers for html and watch, not for text.
		expect(typeof calls[0]?.shared.embedImage).toBe("function");
		expect(typeof calls[1]?.shared.embedImageData).toBe("function");
		expect(calls[2]?.shared.embedImage).toBeUndefined();
		expect(calls[2]?.shared.brandName).toBe("Acme");

		expect(sent?.text).toBe("rendered text");
		const cid = sent?.html?.match(/cid:([0-9a-f-]{36})/)?.[1];
		expect(cid).toBeDefined();
		expect(sent?.attachments.some((a) => a.cid === cid)).toBe(true);
	});

	it("embedImage() adds a cid attachment read from the path at build", async () => {
		const calls: Call[] = [];
		MessageBuilder.templateEngine = recordingEngine(calls);
		await expect(
			new MessageBuilder().to("a@example.com").htmlView("html").build(),
		).rejects.toMatchObject({ code: "E_ATTACHMENT_UNREADABLE" });
	});

	it("keeps the built-in engine when none is registered", async () => {
		const m = new MessageBuilder().to("a@example.com").htmlView("missing");
		await expect(m.build("/nonexistent-views-root")).rejects.toThrow();
		expect(MessageBuilder.templateEngine).toBeUndefined();
	});
});
