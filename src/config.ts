import type { MailConfig } from "./Mail.js";
import type { RetryConfig } from "./retry.js";

export function defineConfig(config: MailConfig): MailConfig {
	return config;
}

/** One mailer's settings — the transport name plus whatever it reads. */
export interface TransportDescriptor {
	transport: string;
	retry?: RetryConfig;
	[key: string]: unknown;
}

type Options = Record<string, unknown> & { retry?: RetryConfig };

function describe(transport: string) {
	return (config: Options = {}): TransportDescriptor => ({
		...config,
		transport,
	});
}

/**
 * Mailer descriptors for `defineConfig`, matching the AdonisJS call site:
 *
 *   defineConfig({
 *     default: 'smtp',
 *     from: 'noreply@acme.com',
 *     mailers: { smtp: transports.smtp({ host: env.get('SMTP_HOST') }) },
 *   })
 *
 * Named deviation: upstream returns a config PROVIDER that lazily imports the
 * transport. Rover returns the plain descriptor its config can persist, and the
 * transport registers itself on import.
 *
 * Postmark has no helper here on purpose: rover has no Postmark transport, so a
 * migrated config naming it fails to COMPILE — which says so plainly — instead
 * of throwing at boot.
 */
export const transports = {
	smtp: describe("smtp"),
	ses: describe("ses"),
	mailgun: describe("mailgun"),
	sparkpost: describe("sparkpost"),
	resend: describe("resend"),
	brevo: describe("brevo"),
	sendgrid: describe("sendgrid"),
	/** Writes to the logger instead of sending — the local-development mailer. */
	log: describe("log"),
};

export type { MailConfig };
