/**
 * Every bundled transport is imported for its REGISTRATION side effect.
 *
 * Each module calls `registerTransport(name, factory)` when it loads, so a
 * config naming `ses` or `mailgun` only worked if the app had imported that
 * module itself — which nothing told it to do. `defineConfig` offers a helper
 * for each of them, so each has to be there when the config is read.
 */

export type { MailAddress } from "./BaseMail.js";
export { BaseMail } from "./BaseMail.js";
export type { TransportDescriptor } from "./config.js";
export { defineConfig, transports } from "./config.js";
export type {
	EmitterLike,
	MailAttachment,
	MailConfig,
	MailEventBase,
	MailFailedEvent,
	MailHooks,
	MailMessage,
	MailQueueEvent,
	MailSendingEvent,
	MailSendOutcome,
	MailSendResult,
	MailSentEvent,
	MailTransport,
	MailTransportFactory,
	MessageBodyTemplates,
} from "./Mail.js";
export {
	LogTransport,
	Mail,
	Mailer,
	MessageBuilder,
	registerTransport,
	SmtpTransport,
} from "./Mail.js";
export type {
	AttachmentOptions,
	CalendarEvent,
	CalendarEventMethod,
	CalendarEventOptions,
	ListHeader,
	MailEnvelope,
	Recipient,
	RecipientObject,
} from "./MessageBuilder.js";
export { attachmentsFor } from "./MessageBuilder.js";
export { RoverError } from "./RoverError.js";
export { default as RoverProvider } from "./RoverProvider.js";
export {
	DEFAULT_RETRY_CONFIG,
	isRetryableError,
	type RetryConfig,
} from "./retry.js";
export { BrevoTransport } from "./transports/BrevoTransport.js";
export { MailgunTransport } from "./transports/MailgunTransport.js";
export { ResendTransport } from "./transports/ResendTransport.js";
export { SendGridTransport } from "./transports/SendGridTransport.js";
export { SesTransport } from "./transports/SesTransport.js";
export { SparkPostTransport } from "./transports/SparkPostTransport.js";
