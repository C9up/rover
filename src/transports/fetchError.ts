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
