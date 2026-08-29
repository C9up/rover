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
 * One helper per transport rover ships. Each returns the descriptor a
 * `mailers` entry is made of — the transport name plus the settings that
 * transport reads:
 *
 *   defineConfig({
 *     default: 'smtp',
 *     from: 'noreply@acme.com',
 *     mailers: { smtp: transports.smtp({ host: env.get('SMTP_HOST') }) },
 *   })
 *
 * The descriptor is plain data, so a config file can be serialised and
 * inspected; the transport itself registers on import of the package entry.
 *
 * The list is exactly what rover can send through — naming a transport that
 * has no helper fails to COMPILE, which says so plainly, instead of throwing
 * at boot.
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
