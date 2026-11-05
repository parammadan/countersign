import { describe, it, expect } from "vitest";
import { parseCsv, toCsv } from "../lib/csv";

describe("csv", () => {
  it("parses quotes, commas, CRLF and BOM", () => {
    expect(parseCsv('﻿client_name,client_email,fee\r\n"Sample, Jordan",j@example.com,"4,500"\r\n\r\nAlex "A" Test,a@example.com,1\n')).toEqual([
      ["client_name", "client_email", "fee"],
      ["Sample, Jordan", "j@example.com", "4,500"],
      ['Alex "A" Test', "a@example.com", "1"],
    ]);
  });
  it("escapes and neutralises formulas", () => {
    expect(toCsv([["a,b", 'q"t', "=HYPERLINK(1)", null]])).toBe('"a,b","q""t",\'=HYPERLINK(1),');
  });
});
