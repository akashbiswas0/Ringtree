import { afterEach, describe, expect, it } from "vitest";
import {
  clearSessionPassword,
  hasSessionPassword,
  setSessionPassword,
  withSessionPassword,
} from "../server/session-password";

describe("broker session password", () => {
  afterEach(clearSessionPassword);

  it("keeps the password out of the process environment", async () => {
    delete process.env.WALLET_PASS;
    setSessionPassword("test-only-password");
    expect(hasSessionPassword()).toBe(true);
    expect(process.env.WALLET_PASS).toBeUndefined();
    expect(await withSessionPassword(async (password) => password.length)).toBe(
      18,
    );
  });

  it("fails closed when the session is locked", async () => {
    clearSessionPassword();
    await expect(withSessionPassword(async () => true)).rejects.toThrow(
      "KEY_RING_UNLOCK_REQUIRED",
    );
    expect(() => setSessionPassword("")).toThrow("KEY_RING_PASSWORD_REQUIRED");
  });
});
