import { describe, expect, it } from "bun:test";
import { isCliInvocation } from "./cli-argv";

describe("isCliInvocation", () => {
	it("treats CLI commands as CLI invocations", () => {
		expect(isCliInvocation(["hosts", "list"])).toBe(true);
		expect(isCliInvocation(["hosts", "--help"])).toBe(true);
		expect(isCliInvocation(["status"])).toBe(true);
	});

	it("treats help and version flags as CLI invocations", () => {
		expect(isCliInvocation(["--help"])).toBe(true);
		expect(isCliInvocation(["-h"])).toBe(true);
		expect(isCliInvocation(["--version"])).toBe(true);
		expect(isCliInvocation(["-v"])).toBe(true);
	});

	it("leaves desktop launches alone", () => {
		expect(isCliInvocation([])).toBe(false);
		expect(isCliInvocation(["--new-window"])).toBe(false);
		expect(isCliInvocation(["superset://auth/callback?code=x"])).toBe(false);
		expect(isCliInvocation(["--ozone-platform=wayland"])).toBe(false);
	});
});
