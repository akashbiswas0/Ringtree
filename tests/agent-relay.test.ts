import { expect, it } from "vitest";
import request from "supertest";
import { createRelay } from "../server/agent-relay";
it("denies owner routes and prevents an agent impersonating the local connector", async () => {
  const { agents, connector } = createRelay("a".repeat(64));
  for (const path of ["submit", "signed", "hosts", "revoke", "broadcast"])
    expect((await request(agents).post(`/api/${path}`).send({})).status).toBe(403);
  expect((await request(agents).get("/api/state")).status).toBe(403);
  expect((await request(connector).get("/connector/next")).status).toBe(403);
  expect((await request(connector).get("/connector/next").set("Authorization", `Bearer ${"a".repeat(64)}`)).status).toBe(204);
});
it("requires a full random-token encoding", () => {
  expect(() => createRelay("short-token")).toThrow("RELAY_TOKEN_REQUIRED");
  expect(() => createRelay("G".repeat(64))).toThrow("RELAY_TOKEN_REQUIRED");
});
it("forwards an allowed signed call without exposing a broker port", async () => {
  const token = "a".repeat(64);
  const { agents, connector } = createRelay(token);
  const pending = request(agents)
    .get("/api/agent-state")
    .then((response) => response);
  await new Promise((resolve) => setImmediate(resolve));
  const next = await request(connector)
    .get("/connector/next")
    .set("Authorization", `Bearer ${token}`);
  expect(next.body).toMatchObject({
    path: "agent-state",
    method: "GET",
  });
  expect(
    (
      await request(connector)
        .post(`/connector/result/${next.body.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status: 200, body: { ok: true }, unexpected: true })
    ).status,
  ).toBe(400);
  expect(
    (
      await request(connector)
        .post(`/connector/result/${next.body.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status: 200, body: { ok: true } })
    ).status,
  ).toBe(204);
  expect((await pending).body).toEqual({ ok: true });
});
