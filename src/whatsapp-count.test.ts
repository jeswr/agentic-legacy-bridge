// AUTHORED-BY Claude Fable 5
import { describe, expect, it } from "vitest";
import { whatsappMessageCount } from "./whatsapp.js";

function delivery(n: number): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              messages: Array.from({ length: n }, (_, i) => ({
                from: "15551230000",
                id: `wamid.${i}`,
                timestamp: "1700000000",
                type: "text",
                text: { body: `m${i}` },
              })),
            },
          },
        ],
      },
    ],
  });
}

describe("whatsappMessageCount — the fan-out arity", () => {
  it("counts the messages in a delivery", () => {
    expect(whatsappMessageCount(delivery(3))).toBe(3);
    expect(whatsappMessageCount(delivery(1))).toBe(1);
  });

  it("returns 0 for a status/receipt change (no messages)", () => {
    const statusOnly = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "statuses", value: { statuses: [{ id: "x" }] } }] }],
    });
    expect(whatsappMessageCount(statusOnly)).toBe(0);
  });

  it("returns 0 fail-closed for non-JSON / non-object / oversize", () => {
    expect(whatsappMessageCount("not json")).toBe(0);
    expect(whatsappMessageCount("[]")).toBe(0);
    expect(whatsappMessageCount("x".repeat(2 * 1024 * 1024))).toBe(0);
  });

  it("counts non-text entries too (they are refused per-index, not pre-filtered)", () => {
    const mixed = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                messages: [
                  { from: "1555", id: "wamid.A", type: "image", image: { id: "x" } },
                  { from: "1555", id: "wamid.B", type: "text", text: { body: "hi" } },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(whatsappMessageCount(mixed)).toBe(2);
  });
});
