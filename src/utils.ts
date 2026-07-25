import { minimatch } from 'minimatch';

/**
 * Converts an unknown error to a string message.
 * @param error The error to convert
 * @returns The error message as a string
 */
export function errorToString(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

/**
 * Matches a value against an array of glob patterns, with support for aliases.
 * @param value The value to match
 * @param patterns An array of glob patterns to match against
 * @param aliases A record of aliases for values, where the key is the alias and the value is the actual value to match against the patterns
 * @returns True if the value matches any of the patterns (after resolving aliases), false otherwise
 */
export function matchPatterns(
	value: string,
	patterns: string[],
	aliases: Record<string, string>
): boolean {
	for (const pattern of patterns) {
		const resolvedPattern = aliases[pattern] ?? pattern;
		if (minimatch(value, resolvedPattern)) {
			return true;
		}
	}
	return false;
}
