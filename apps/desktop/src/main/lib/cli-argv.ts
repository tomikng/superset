const CLI_FLAGS = new Set(["--help", "-h", "--version", "-v"]);
const CLI_COMMAND = /^[a-z][a-z-]*$/;

/**
 * Whether the app binary was invoked as the CLI (`superset hosts list`,
 * `superset --help`) rather than as the desktop app. The desktop entry only
 * ever passes `superset://` URLs and `--` flags, so a bare command word or a
 * help/version flag in first position means the CLI was wanted.
 */
export function isCliInvocation(args: string[]): boolean {
	const first = args[0];
	if (!first) return false;
	return CLI_FLAGS.has(first) || CLI_COMMAND.test(first);
}
