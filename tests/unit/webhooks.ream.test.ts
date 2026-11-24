/**
 * The three webhook handlers on Ream's real stack — native server, router,
 * JSON body parser — mounted as the README mounts them: the handler itself is
 * the route handler, and it reads the signed bytes with `request.rawBuffer()`.
 */

import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { BodyParserMiddleware, type HttpContext, Ignitor } from "@c9up/ream";
import { createHyperServerFactory } from "@c9up/ream/bootstrap";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMailgunWebhookHandler } from "../../src/webhooks/mailgun.js";
import { createResendWebhookHandler } from "../../src/webhooks/resend.js";
import { createSendGridWebhookHandler } from "../../src/webhooks/sendgrid.js";

const MAILGUN_KEY = "key-test-signing";
const RESEND_SECRET = Buffer.from("0123456789abcdef0123456789abcdef").toString(
	"base64",
);
// What SendGrid issues: an ECDSA key on P-256, base64 DER in the dashboard.
const sendgrid = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const SENDGRID_PUBLIC = sendgrid.publicKey
	.export({ format: "der", type: "spki" })
	.toString("base64");

const now = () => String(Math.floor(Date.now() / 1000));
let counter = 0;

interface Delivery {
	body: string;
	headers: Record<string, string>;
}

const providers: Record<string, (body?: string) => Delivery> = {
	mailgun: () => {
		const timestamp = now();
		const token = `tok-${++counter}-${"x".repeat(40)}`;
		return {
			body: JSON.stringify({
				signature: {
					timestamp,
					token,
					signature: createHmac("sha256", MAILGUN_KEY)
						.update(timestamp + token)
						.digest("hex"),
				},
				"event-data": {
					event: "delivered",
					recipient: "a@example.com",
					timestamp: 1700000000,
				},
			}),
			headers: {},
		};
	},
	sendgrid: () => {
		const timestamp = now();
		const body = JSON.stringify([
			{
				event: "delivered",
				email: "a@example.com",
				sg_message_id: "m1",
				timestamp: 1700000000,
			},
		]);
		return {
			body,
			headers: {
				"x-twilio-email-event-webhook-signature": sign(
					"sha256",
					Buffer.from(timestamp + body),
					sendgrid.privateKey,
				).toString("base64"),
				"x-twilio-email-event-webhook-timestamp": timestamp,
			},
		};
	},
	resend: () => {
		const timestamp = now();
		const id = `msg_${++counter}`;
		const body = JSON.stringify({
			type: "email.delivered",
			data: { email_id: "e1", to: ["a@example.com"] },
		});
		return {
			body,
			headers: {
				"svix-id": id,
				"svix-timestamp": timestamp,
				"svix-signature": `v1,${createHmac("sha256", Buffer.from(RESEND_SECRET, "base64")).update(`${id}.${timestamp}.${body}`).digest("base64")}`,
			},
		};
	},
};

describe("rover webhook handlers on a Ream route", () => {
	const events: Array<{ route: string; name: string }> = [];
	const emitterFor = (route: string) => ({
		emit(name: string) {
			events.push({ route, name });
		},
	});
	let ignitor: Ignitor;
	let base = "";

	beforeAll(async () => {
		const serverFactory = createHyperServerFactory();
		if (serverFactory === undefined) {
			throw new Error("@c9up/ream found no loadable HTTP server binary");
		}
		const bodyParser = new BodyParserMiddleware();
		const parseBody = (ctx: HttpContext, next: () => Promise<void>) =>
			bodyParser.handle(ctx, next);
		const handlers = (route: string) => ({
			mailgun: createMailgunWebhookHandler({
				signingKey: MAILGUN_KEY,
				emitter: emitterFor(route),
			}),
			sendgrid: createSendGridWebhookHandler({
				publicKey: SENDGRID_PUBLIC,
				emitter: emitterFor(route),
			}),
			resend: createResendWebhookHandler({
				secret: `whsec_${RESEND_SECRET}`,
				emitter: emitterFor(route),
			}),
		});
		ignitor = await new Ignitor({
			port: 0,
			gracefulShutdown: false,
			serverFactory,
		})
			.routes((router) => {
				// As the README mounts them: no adapter, no cast.
				for (const [name, handler] of Object.entries(handlers("plain"))) {
					router.post(`/webhooks/${name}`, handler);
				}
				// Behind the JSON body parser, as a scaffolded app has it.
				for (const [name, handler] of Object.entries(handlers("parsed"))) {
					router.post(`/parsed/${name}`, handler).use(parseBody);
				}
			})
			.httpServer()
			.start();
		base = `http://127.0.0.1:${await ignitor.port()}`;
	});

	afterAll(async () => {
		await ignitor.stop();
	});

	async function post(path: string, { body, headers }: Delivery) {
		const response = await fetch(`${base}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body,
		});
		return { status: response.status, body: await response.json() };
	}

	for (const prefix of ["webhooks", "parsed"]) {
		const route = prefix === "webhooks" ? "plain" : "parsed";
		for (const name of ["mailgun", "sendgrid", "resend"]) {
			const deliver = providers[name];
			if (deliver === undefined) throw new Error(name);

			it(`/${prefix}/${name}: a signed delivery is a 200 and its event`, async () => {
				const before = events.length;
				expect(await post(`/${prefix}/${name}`, deliver())).toEqual({
					status: 200,
					body: { ok: true },
				});
				expect(events.slice(before)).toEqual([
					{ route, name: "mail.delivered" },
				]);
			});

			it(`/${prefix}/${name}: a tampered body or an unsigned request is a 401, no event`, async () => {
				const before = events.length;
				const signed = deliver();
				// Mailgun signs the token, not the event: the token is what a
				// forger has to change.
				const tampered = {
					...signed,
					body:
						name === "mailgun"
							? signed.body.replace("tok-", "tak-")
							: signed.body.replace("a@example.com", "b@example.com"),
				};
				expect((await post(`/${prefix}/${name}`, tampered)).status).toBe(401);
				const answer = await post(`/${prefix}/${name}`, {
					body:
						name === "mailgun"
							? JSON.stringify({ "event-data": { event: "delivered" } })
							: signed.body,
					headers: {},
				});
				expect(answer.status).toBe(401);
				expect(events.length).toBe(before);
			});
		}
	}
});
