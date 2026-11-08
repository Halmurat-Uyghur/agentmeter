import { describe, expect, it } from "vitest";
import { cleanCurrencyCode, parseRate, rangeToUsd } from "../../src/core/currency";
import { afterEach } from "vitest";
import { costLabel, costNotes, formatRange, formatUsd, money, setDisplayCurrency, tooltipMarkdown } from "../../src/core/format";
import type { Currency, Metric } from "../../src/core/types";

const CAD: Currency = { code: "CAD", rate: 1.4, date: "2026-11-06" };
const m = (sum: number, reported = 1, missing = 0): Metric => ({ sum, reported, missing });

describe("currency", () => {
  afterEach(() => setDisplayCurrency(undefined));

  it("money converts and uses the currency symbol; USD unchanged", () => {
    expect(money(10)).toBe("$10.00");
    expect(money(10, { code: "USD", rate: 1, date: "2026-11-06" })).toBe("$10.00");
    expect(money(10, CAD)).toBe("CA$14.00");
    expect(money(100, CAD)).toBe("CA$140");
    expect(money(0.01, CAD)).toBe("CA$0.014");
    expect(money(0, CAD)).toBe("CA$0.00");
    expect(money(10, { code: "EUR", rate: 0.9, date: "2026-11-06" })).toBe("€9.00");
  });

  it("formatUsd and formatRange follow the currency; targets round-trip", () => {
    expect(formatUsd(m(1000e9), CAD)).toBe("CA$14.00");
    expect(formatUsd(m(1000e9, 1, 1), CAD)).toBe("CA$14.00*");
    const r = rangeToUsd({ min: 20, max: 60 }, CAD);
    expect(r!.max).toBeCloseTo(60 / 1.4);
    expect(formatRange(r, CAD)).toBe("CA$20.00–CA$60.00");
    expect(rangeToUsd({ min: 5 }, undefined)).toEqual({ min: 5 });
  });

  it("labels and notes", () => {
    expect(costLabel()).toBe("USD (est.)");
    setDisplayCurrency(CAD);
    expect(costLabel()).toBe("CAD (est.)");
    expect(money(10)).toBe("CA$14.00");
    setDisplayCurrency({ code: "USD", rate: 1, date: "2026-11-06" });
    expect(money(10)).toBe("$10.00");
    expect(costNotes({ unit: "cost", currency: CAD })[1]).toContain("1 USD = 1.4 CAD");
    expect(costNotes({ unit: "cost", currencyPending: "CAD" })[1]).toContain("No CAD exchange rate yet");
    expect(costNotes({ unit: "cost" })).toHaveLength(1);
    expect(tooltipMarkdown(undefined, { unit: "cost", currency: CAD })).not.toContain("CAD");
  });

  it("cleanCurrencyCode", () => {
    expect(cleanCurrencyCode("cad")).toBe("CAD");
    expect(cleanCurrencyCode(" eur ")).toBe("EUR");
    expect(cleanCurrencyCode("CA$")).toBe("USD");
    expect(cleanCurrencyCode(undefined)).toBe("USD");
  });

  it("parseRate accepts only a well-formed USD-based answer", () => {
    expect(parseRate({ amount: 1, base: "USD", date: "2026-11-06", rates: { CAD: 1.4066 } }, "CAD")).toEqual({ code: "CAD", rate: 1.4066, date: "2026-11-06" });
    expect(parseRate({ base: "EUR", date: "2026-11-06", rates: { CAD: 1.4 } }, "CAD")).toBeUndefined();
    expect(parseRate({ base: "USD", date: "x", rates: { CAD: 1.4 } }, "CAD")).toBeUndefined();
    expect(parseRate({ base: "USD", date: "2026-11-06", rates: { CAD: -1 } }, "CAD")).toBeUndefined();
    expect(parseRate({ base: "USD", date: "2026-11-06", rates: { CAD: "1.4" } }, "CAD")).toBeUndefined();
    expect(parseRate({ base: "USD", date: "2026-11-06", rates: {} }, "CAD")).toBeUndefined();
    expect(parseRate(null, "CAD")).toBeUndefined();
  });

  it("parseRate rejects invalid dates and implausibly small rates", () => {
    expect(parseRate({ base: "USD", date: "2026-99-99", rates: { CAD: 1.4 } }, "CAD")).toBeUndefined();
    expect(parseRate({ base: "USD", date: "2026-02-30", rates: { CAD: 1.4 } }, "CAD")).toBeUndefined();
    expect(parseRate({ base: "USD", date: "2026-11-06", rates: { CAD: 1e-12 } }, "CAD")).toBeUndefined();
    expect(parseRate({ base: "USD", date: "2026-11-06", rates: { CAD: 1e-6 } }, "CAD")).toEqual({ code: "CAD", rate: 1e-6, date: "2026-11-06" });
    expect(parseRate({ base: "USD", date: "1999-01-01", rates: { CAD: 1.4 } }, "CAD")).toBeDefined();
  });

  it("cleanCurrencyCode maps unknown codes to USD", () => {
    expect(cleanCurrencyCode("XYZ")).toBe("USD");
    expect(cleanCurrencyCode("krw")).toBe("KRW");
  });
});
