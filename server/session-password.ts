let sessionPassword: Buffer | undefined;

export function setSessionPassword(password: string) {
  if (!password) throw new Error("KEY_RING_PASSWORD_REQUIRED");
  clearSessionPassword();
  sessionPassword = Buffer.from(password, "utf8");
}

export function hasSessionPassword() {
  return Boolean(sessionPassword?.length);
}

export async function withSessionPassword<T>(
  action: (password: string) => Promise<T>,
) {
  if (!sessionPassword?.length) throw new Error("KEY_RING_UNLOCK_REQUIRED");
  return action(sessionPassword.toString("utf8"));
}

export function clearSessionPassword() {
  sessionPassword?.fill(0);
  sessionPassword = undefined;
}

process.once("exit", clearSessionPassword);
