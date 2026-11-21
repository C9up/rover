import { RoverError } from "../RoverError.js";

/** Hosts a key sent over plain HTTP never leaves: a local mock of the API. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The API base URL a transport sends its key to, checked.
 *
 * NAMED DEVIATION — upstream takes `baseUrl` as written. It is where every
 * request carries the provider's API key, so a value from a mistyped or
 * tampered environment variable hands the key to whoever answers there, and
 * an `http://` one hands it to the network on the way. Here it must be HTTPS
 * (plain HTTP only to a loopback host, for a local mock), and carry no
 * credentials, query or fragment of its own.
 */
export function apiBaseUrl(
	provider: string,
	value: string,
	fallback: string,
): string {
	if (value === "") return fallback;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw invalid(provider, value, "it is not a URL");
	}
	const loopback = LOOPBACK.has(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
		throw invalid(
			provider,
			value,
			"it must be https:// (plain http:// only to localhost)",
		);
	}
	if (url.username !== "" || url.password !== "") {
		throw invalid(provider, value, "it must not carry credentials");
	}
	if (url.search !== "" || url.hash !== "") {
		throw invalid(provider, value, "it must not carry a query or a fragment");
	}
	return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

function invalid(provider: string, value: string, reason: string): RoverError {
	return new RoverError(
		"E_MAIL_PROVIDER_CONFIG",
		`${provider} baseUrl "${value}" is refused: ${reason}.`,
		{
			hint: "Every request to this URL carries the API key. Leave baseUrl out for the provider's own endpoint.",
		},
	);
}
