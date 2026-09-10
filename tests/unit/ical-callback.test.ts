/**
 * `icalEvent(callback)` — building an invitation instead of pasting one.
 *
 * Upstream accepts either an ICS string or a callback handed an
 * `ical-generator` calendar. Taking only the string meant a caller had to
 * assemble iCalendar by hand, or install and drive the library themselves and
 * pass the result — which is the same work, minus the ergonomics that made the
 * callback worth having.
 */
import { describe, expect, it } from "vitest";
import { MessageBuilder } from "../../src/MessageBuilder.js";

function message(): MessageBuilder {
	return new MessageBuilder()
		.from("organiser@example.com")
		.to("guest@example.com")
		.subject("Invitation");
}

describe("rover > icalEvent(callback)", () => {
	it("runs the callback against a real calendar and carries the result", async () => {
		const built = await message()
			.icalEvent(
				(calendar) => {
					calendar.createEvent({
						start: new Date("2026-03-01T10:00:00Z"),
						end: new Date("2026-03-01T11:00:00Z"),
						summary: "Sprint review",
						location: "Room 2",
					});
				},
				{ method: "REQUEST", filename: "invite.ics" },
			)
			.build();

		const ics = built.icalEvent?.content ?? "";
		// Not a smoke test: this is real iCalendar, and a consumer's calendar
		// client will refuse anything that is not.
		expect(ics).toContain("BEGIN:VCALENDAR");
		expect(ics).toContain("BEGIN:VEVENT");
		expect(ics).toContain("SUMMARY:Sprint review");
		expect(ics).toContain("END:VCALENDAR");
		// The options ride along, as they do for the string form.
		expect(built.icalEvent?.method).toBe("REQUEST");
		expect(built.icalEvent?.filename).toBe("invite.ics");
	});

	it("still accepts a plain ICS string", async () => {
		const built = await message()
			.icalEvent("BEGIN:VCALENDAR\nEND:VCALENDAR", { method: "PUBLISH" })
			.build();
		expect(built.icalEvent?.content).toBe("BEGIN:VCALENDAR\nEND:VCALENDAR");
		expect(built.icalEvent?.method).toBe("PUBLISH");
	});

	it("lets the last call win, whichever form it took", async () => {
		// A builder that kept a stale pending callback would ship the wrong
		// invitation, and only for the caller who changed their mind.
		const fromString = await message()
			.icalEvent(() => undefined)
			.icalEvent("BEGIN:VCALENDAR\nEND:VCALENDAR")
			.build();
		expect(fromString.icalEvent?.content).toBe(
			"BEGIN:VCALENDAR\nEND:VCALENDAR",
		);

		const fromCallback = await message()
			.icalEvent("BEGIN:VCALENDAR\nEND:VCALENDAR")
			.icalEvent((calendar) => {
				calendar.createEvent({
					start: new Date("2026-03-01T10:00:00Z"),
					summary: "Later",
				});
			})
			.build();
		expect(fromCallback.icalEvent?.content).toContain("SUMMARY:Later");
	});

	it("resolves at build(), so the chain stays synchronous", () => {
		// The callback runs against a package imported dynamically; doing that
		// in `icalEvent()` would have made the fluent API return a promise.
		const builder = message().icalEvent((calendar) => {
			calendar.createEvent({ start: new Date(), summary: "x" });
		});
		expect(builder).toBeInstanceOf(MessageBuilder);
	});
});
