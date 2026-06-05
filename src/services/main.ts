/**
 * Default `Mail` singleton — mirror of Adonis's
 * `import mail from '@adonisjs/mail/services/main'` shape.
 *
 * The instance is populated by `RoverProvider.boot()` once the
 * container has resolved the `Mail` binding. Callers can `import mail`
 * before boot — the proxy delays method access until `_setMail` runs.
 *
 *   import mail from '@c9up/rover/services/main'
 *
 *   await mail.send((m) => m.to(user.email).subject('Hi').text('Hello'))
 */

import type { Mail } from "../Mail.js";

let _instance: Mail | undefined;

/** @internal Set the resolved singleton (called by RoverProvider.boot). */
export function _setMail(instance: Mail): void {
	_instance = instance;
}

/** @internal Get the resolved singleton (or `undefined` pre-boot). */
export function _getMail(): Mail | undefined {
	return _instance;
}

const mail: Mail = new Proxy({} as Mail, {
	get(_target, prop) {
		if (!_instance) {
			throw new Error(
				"[rover] Mail singleton accessed before RoverProvider.boot() ran. " +
					"Check that `@c9up/rover/provider` is listed in your reamrc.ts providers.",
			);
		}
		const value = Reflect.get(_instance, prop, _instance);
		return typeof value === "function" ? value.bind(_instance) : value;
	},
});

export default mail;
