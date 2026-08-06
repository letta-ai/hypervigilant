import { describe, expect, it } from "bun:test";
import { formatGreeting } from "../src/greeting.ts";

describe("formatGreeting", () => {
	it("greets a normal name", () => {
		expect(formatGreeting("Ada")).toBe("Hello, Ada!");
	});

	it("trims surrounding whitespace", () => {
		expect(formatGreeting("  Ada  ")).toBe("Hello, Ada!");
	});

	it("uses the stranger fallback for an empty name", () => {
		expect(formatGreeting("   ")).toBe("Hello, stranger!");
	});
});
