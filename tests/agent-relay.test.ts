import { expect, it } from "vitest";
import request from "supertest";
import { createRelay } from "../server/agent-relay";
it("denies owner routes and prevents an agent impersonating the local connector", async () => {
  const { agents, connector } = createRelay("a".repeat(64));
  for (const path of ["submit", "signed", "hosts", "revoke", "broadcast"])
    expect((await request(agents).post(`/api/${path}`).send({})).status).toBe(403);
  expect((await request(connector).get("/connector/next")).status).toBe(403);
  expect((await request(connector).get("/connector/next").set("Authorization", `Bearer ${"a".repeat(64)}`)).status).toBe(204);
});
