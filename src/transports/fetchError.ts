import { RoverError } from "../RoverError.js";

/**
 * Wrap a `fetch()` rejection into the uniform `MAIL_PROVIDER_ERROR` shape
 * so the retry classifier can recognise transient network failures
 * (ECONNRESET / ENOTFOUND / EAI_AGAIN / ...).
 *
 * Node 18+ `fetch` (undici) rejects with `TypeError: fetch failed` and
 * stashes the original errno on `cause.code` rather than top-level `.code`.
 * Surface both shapes — older custom HTTP layers and SDK wrappers may set
 * `code` directly.
 */
export function wrapFetchNetworkError(
	provider: string,
	err: unknown,
): RoverError {
	if (err instanceof RoverError) return err;
	const top = err as { code?: unknown; cause?: unknown; message?: unknown };
	const cause = top.cause as { code?: unknown } | undefined;
	const networkCode =
		typeof top.code === "string"
			? top.code
			: typeof cause?.code === "string"
				? cause.code
				: undefined;
	const message =
		typeof top.message === "string" ? top.message : "fetch failed";
	const ctx: Record<string, string> = {
		provider,
		upstreamStatus: "0",
		providerMessage: message,
	};
	if (networkCode) ctx.networkCode = networkCode;
	return new RoverError(
		"MAIL_PROVIDER_ERROR",
		`${provider} fetch failed${networkCode ? ` (${networkCode})` : ""}`,
		{
			hint: "Inspect `context.networkCode` (ECONNRESET / ENOTFOUND / ...) — the retry classifier treats known transient errnos as retryable.",
			context: ctx,
		},
	);
}

/** Default ceiling on one provider request. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * `fetch` with a deadline.
 *
 * Without one, a stalled provider connection never settles: the send hangs,
 * the queue worker holding it hangs with it, and enough of them stop mail going
 * out at all — with no error to explain the silence. A timeout surfaces as the
 * same `MAIL_PROVIDER_ERROR` shape the retry classifier already understands, so
 * it is retried like any other transient network failure.
 */
export async function fetchWithTimeout(
	provider: string,
	url: string,
	init: RequestInit = {},
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
	if (timeoutMs <= 0) return fetch(url, init);
	try {
		return await fetch(url, {
			...init,
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		if (err instanceof Error && err.name === "TimeoutError") {
			throw new RoverError(
				"MAIL_PROVIDER_ERROR",
				`${provider} did not answer within ${timeoutMs}ms.`,
				{
					context: { provider, upstreamStatus: "0", networkCode: "ETIMEDOUT" },
					hint: "Raise `requestTimeoutMs` for large attachments, or check connectivity to the provider.",
				},
			);
		}
		throw wrapFetchNetworkError(provider, err);
	}
}
