import { BaseMail } from "@c9up/rover";
import type { Order, User } from "./domain.js";

export default class OrderShippedMail extends BaseMail {
	from = { address: "orders@acme.com", name: "Acme Orders" };

	constructor(
		private user: User,
		private order: Order,
	) {
		super();
	}

	async prepare() {
		this.message
			.to(this.user.email)
			.subject(`Your order #${this.order.id} has shipped`)
			.html(
				`<p>Hi ${this.user.name}, your order is on its way.</p>` +
					`<p>Track it: <a href="${this.order.trackingUrl}">${this.order.trackingUrl}</a></p>`,
			);
	}
}
