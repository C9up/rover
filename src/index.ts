export type { MailAddress } from "./BaseMail.js";
export { BaseMail } from "./BaseMail.js";
export { defineConfig } from "./config.js";
export type {
	EmitterLike,
	MailAttachment,
	MailConfig,
	MailFailedEvent,
	MailHooks,
	MailMessage,
	MailSendOutcome,
	MailSendResult,
	MailSentEvent,
	MailTransport,
	MailTransportFactory,
} from "./Mail.js";
export {
	LogTransport,
	Mail,
	MessageBuilder,
	registerTransport,
	SmtpTransport,
} from "./Mail.js";
export { default as RoverProvider } from "./RoverProvider.js";
export {
	DEFAULT_RETRY_CONFIG,
	isRetryableError,
	type RetryConfig,
} from "./retry.js";
