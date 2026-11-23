import type { Exception } from "@c9up/flare";

/**
 * Sets the advice a throw site knows on the error it raises, and returns the
 * error. For a code whose help depends on where it is raised; a constant help
 * is the class's static `help`.
 */
export function withHelp<T extends Exception>(error: T, help: string): T {
	error.help = help;
	return error;
}
