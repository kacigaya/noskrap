import { expect, test } from "bun:test";
import { showBotDetectedPopup } from "./client";

test("shows popup for challenge and block decisions", () => {
  const messages: string[] = [];
  const show = (message: string) => messages.push(message);

  expect(showBotDetectedPopup("challenge", { show })).toBe(true);
  expect(showBotDetectedPopup({ decision: "block" }, { show })).toBe(true);
  expect(messages).toEqual(["Bot detected.", "Bot detected."]);
});

test("does not show popup for allow or observe decisions", () => {
  const messages: string[] = [];
  const show = (message: string) => messages.push(message);

  expect(showBotDetectedPopup("allow", { show })).toBe(false);
  expect(showBotDetectedPopup({ decision: "observe" }, { show })).toBe(false);
  expect(messages).toEqual([]);
});

test("uses custom message", () => {
  const messages: string[] = [];

  expect(
    showBotDetectedPopup("block", {
      message: "Suspicious traffic detected.",
      show: (message) => messages.push(message),
    }),
  ).toBe(true);
  expect(messages).toEqual(["Suspicious traffic detected."]);
});
