/**
 * `ream configure @c9up/rover` — wire mail in one command.
 *
 * The provider alone is not enough: it reads `config/mail.ts`, and a package
 * registered without one falls back to a default that is rarely the one an
 * application wants. Writing both together is what makes `ream add` mean
 * installed AND working.
 */

interface Codemods {
	addProvider(importPath: string): Promise<void>;
	addEnvVars(vars: Record<string, string>): Promise<void>;
	writeFile(
		filePath: string,
		content: string,
		options?: { force?: boolean },
	): Promise<void>;
}

export async function configure(codemods: Codemods): Promise<void> {
	// The config below reads these, so they are declared here. Writing the file
	// without them leaves an application whose config asks the environment for
	// something nothing ever put there.
	await codemods.addEnvVars({
		MAIL_MAILER: "log",
		MAIL_FROM: "noreply@example.com",
		SMTP_HOST: "",
		SMTP_PORT: "587",
	});

	await codemods.addProvider("@c9up/rover/provider");
	await codemods.writeFile(
		"config/mail.ts",
		`import { defineConfig, transports } from '@c9up/rover'
import env from '#start/env'

export default defineConfig({
  // Has to name one of the mailers below, or the application refuses to boot.
  default: env.get('MAIL_MAILER', 'log'),
  from: env.get('MAIL_FROM', 'noreply@example.com'),

  mailers: {
    // Writes to the logger instead of sending. The development mailer.
    log: transports.log(),

    smtp: transports.smtp({
      host: env.get('SMTP_HOST', ''),
      port: Number(env.get('SMTP_PORT', '587')),
    }),
  },
})`,
	);
}
