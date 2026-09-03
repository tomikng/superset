import { describe, expect, it } from "bun:test";
import { wrapIndex } from "./useOrganizationShortcuts";

describe("wrapIndex", () => {
	it("leaves an in-range index alone", () => {
		expect(wrapIndex(1, 3)).toBe(1);
	});

	it("wraps past the end to the start", () => {
		expect(wrapIndex(3, 3)).toBe(0);
	});

	it("wraps before the start to the end", () => {
		expect(wrapIndex(-1, 3)).toBe(2);
	});

	it("collapses to the only organization", () => {
		expect(wrapIndex(-1, 1)).toBe(0);
	});
});
