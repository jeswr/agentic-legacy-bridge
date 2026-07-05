// AUTHORED-BY Claude Fable 5
import { describe, expect, it } from "vitest";
import { asBoundedString, firstProp, parseWhen, prop } from "./values.js";

describe("prop / firstProp (own-property-only reads)", () => {
  it("reads own properties only — never the prototype chain", () => {
    expect(prop({ a: 1 }, "a")).toBe(1);
    expect(prop({}, "constructor")).toBeUndefined();
    expect(prop({}, "toString")).toBeUndefined();
    expect(prop({}, "__proto__")).toBeUndefined();
  });
  it("treats a JSON __proto__ key as an ordinary own property", () => {
    const parsed: unknown = JSON.parse('{"__proto__": {"polluted": true}, "x": 1}');
    expect(prop(parsed, "x")).toBe(1);
    // No pollution happened:
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("rejects arrays and primitives", () => {
    expect(prop([1, 2], "0")).toBeUndefined();
    expect(prop("str", "length")).toBeUndefined();
    expect(prop(null, "a")).toBeUndefined();
  });
  it("firstProp honours alias order", () => {
    expect(firstProp({ b: 2, a: 1 }, ["a", "b"])).toBe(1);
    expect(firstProp({ b: 2 }, ["a", "b"])).toBe(2);
    expect(firstProp({}, ["a", "b"])).toBeUndefined();
  });
});

describe("asBoundedString", () => {
  it("strips controls, trims, caps", () => {
    expect(asBoundedString("  hithere ", 20)).toBe("hithere");
    expect(asBoundedString("x".repeat(21), 20)).toBeUndefined();
    expect(asBoundedString(42, 20)).toBeUndefined();
    expect(asBoundedString("   ", 20)).toBeUndefined();
  });
});

describe("parseWhen", () => {
  it("canonicalises an explicit-UTC datetime", () => {
    expect(parseWhen("2026-07-08T14:00:00Z")).toEqual({
      kind: "dateTime",
      value: "2026-07-08T14:00:00.000Z",
      ambiguous: false,
    });
  });
  it("resolves an explicit offset to UTC", () => {
    expect(parseWhen("2027-03-04T19:30:00-08:00")?.value).toBe("2027-03-05T03:30:00.000Z");
    expect(parseWhen("2026-07-08T16:00+02:00")?.value).toBe("2026-07-08T14:00:00.000Z");
  });
  it("flags a zone-less local time ambiguous (resolved as UTC)", () => {
    expect(parseWhen("2026-07-08T14:00:00")).toEqual({
      kind: "dateTime",
      value: "2026-07-08T14:00:00.000Z",
      ambiguous: true,
    });
  });
  it("accepts a date and keeps it a date", () => {
    expect(parseWhen("2026-07-08")).toEqual({
      kind: "date",
      value: "2026-07-08",
      ambiguous: false,
    });
  });
  it("REJECTS calendar overflow instead of normalising it", () => {
    expect(parseWhen("2026-02-31")).toBeUndefined();
    expect(parseWhen("2026-02-31T10:00:00Z")).toBeUndefined();
    expect(parseWhen("2026-13-01T10:00:00Z")).toBeUndefined();
  });
  it("rejects out-of-range time fields and offsets", () => {
    expect(parseWhen("2026-07-08T24:00:00Z")).toBeUndefined();
    expect(parseWhen("2026-07-08T10:60:00Z")).toBeUndefined();
    expect(parseWhen("2026-07-08T10:00:00+15:00")).toBeUndefined();
  });
  it("drops fractional seconds from the canonical form", () => {
    expect(parseWhen("2026-07-08T14:00:00.500Z")?.value).toBe("2026-07-08T14:00:00.000Z");
  });
  it("rejects hostile / non-string / oversized input", () => {
    expect(parseWhen(undefined)).toBeUndefined();
    expect(parseWhen(1234567890)).toBeUndefined();
    expect(parseWhen("not a date")).toBeUndefined();
    expect(parseWhen(`2026-07-08T14:00:00Z${" ".repeat(100)}`)).toBeUndefined();
    expect(parseWhen("2026-07-08T14:00:00Z<injected>")).toBeUndefined();
  });
});
