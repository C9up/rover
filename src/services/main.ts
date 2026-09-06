/**
 * Default `Mail` singleton — mirror of Adonis's
 * `import mail from '@adonisjs/mail/services/main'` shape.
 *
 * The instance is populated by `RoverProvider.boot()` once the
 * container has resolved the `Mail` binding. Callers can `import mail`
 * before boot — the proxy delays method access until `setMail` runs.
 *
 *   import mail from '@c9up/rover/services/main'
 *
 *   await mail.send((m) => m.to(user.email).subject('Hi').text('Hello'))
 */

import type { Mail } from "../Mail.js";

let instance: Mail | undefined;

/** @internal Set the resolved singleton (called by RoverProvider.boot). */
export function setMail(mail: Mail): void {
	instance = mail;
}

/** @internal Get the resolved singleton (or `undefined` pre-boot). */
export function getMail(): Mail | undefined {
	return instance;
}

/**
 * @internal Release the singleton, so a shut-down application does not leave a
 * dead Mail reachable through `services/main`.
 *
 * The caller checks ownership first (`getMail() === mine`): with two
 * applications in one process, the one shutting down must not clear a binding
 * the other has since installed.
 */
export function clearMail(): void {
	instance = undefined;
}

const mail: Mail = new Proxy({} as Mail, {
	get(_target, prop) {
		if (!instance) {
			throw new Error(
				"[rover] Mail singleton accessed before RoverProvider.boot() ran. " +
					"Check that `@c9up/rover/provider` is listed in your reamrc.ts providers.",
			);
		}
		const value = Reflect.get(instance, prop, instance);
		return typeof value === "function" ? value.bind(instance) : value;
	},
});

export default mail;
