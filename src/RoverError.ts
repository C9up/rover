/**
 * Rover's own structured error — keeps the package framework-agnostic (no
 * dependency on `@c9up/ream`'s `ReamError`). Mirrors the error shape Rover
 * carries through its transports and retry logic.
 */
export class RoverError extends Error {
	/** Error code (e.g. "ROVER_SMTP_ERROR"). */
	readonly code: string;
	/** Additional context key-value pairs. */
	readonly context: Record<string, string>;
	/** Actionable hint for the developer. */
	readonly hint?: string;
	/** Source file where the error originated. */
	readonly sourceFile?: string;
	/** Line number in the source file. */
	readonly sourceLine?: number;
	/** URL to the error documentation page. */
	readonly docsUrl?: string;
	/** Pipeline stage where the error occurred (if applicable). */
	readonly pipelineStage?: string;

	constructor(
		code: string,
		message: string,
		options?: {
			context?: Record<string, string>;
			hint?: string;
			sourceFile?: string;
			sourceLine?: number;
			docsUrl?: string;
			pipelineStage?: string;
		},
	) {
		super(message);
		this.name = "RoverError";
		this.code = code;
		this.context = options?.context ?? {};
		this.hint = options?.hint;
		this.sourceFile = options?.sourceFile;
		this.sourceLine = options?.sourceLine;
		this.docsUrl = options?.docsUrl;
		this.pipelineStage = options?.pipelineStage;
	}
}
