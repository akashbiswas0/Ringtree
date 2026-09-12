import express from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Response } from "express";

// Two distinct listeners: agent network and host-loopback SSM connector.
// No credentials, wallet signing, or provider access live in this process.
export function createRelay(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error("RELAY_TOKEN_REQUIRED");
  const jobs = new Map<string, {
    id: string; path: string; method: string; body: unknown;
    response: Response; delivered: boolean; timer: ReturnType<typeof setTimeout>;
  }>();
  const agents = express();
  const connector = express();
  agents.use(express.json({ limit: "32kb" }));
  connector.use(express.json({ limit: "4mb" }));
  connector.use((req, res, next) => {
    const supplied = Buffer.from(req.get("Authorization") ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.sendStatus(403); return;
    }
    next();
  });
  agents.all("/api/:path", (req, res) => {
    const path = String(req.params.path);
    if (!(req.method === "GET" && path === "agent-state") &&
        !(req.method === "POST" && ["call", "grants", "manifests"].includes(path))) {
      res.status(403).json({ error: "RELAY_ROUTE_DENIED" }); return;
    }
    if (jobs.size >= 64) { res.status(503).json({ error: "RELAY_BUSY" }); return; }
    const id = randomUUID();
    const timer = setTimeout(() => {
      jobs.delete(id);
      if (!res.writableEnded) res.status(503).json({ error: "LOCAL_BROKER_OFFLINE" });
    }, 250000);
    jobs.set(id, { id, path, method: req.method, body: req.body, response: res, delivered: false, timer });
    res.on("close", () => { clearTimeout(timer); jobs.delete(id); });
  });
  connector.get("/connector/next", (_req, res) => {
    const job = [...jobs.values()].find((item) => !item.delivered);
    if (!job) { res.status(204).end(); return; }
    job.delivered = true;
    res.json({ id: job.id, path: job.path, method: job.method, body: job.body });
  });
  connector.post("/connector/result/:id", (req, res) => {
    const job = jobs.get(String(req.params.id));
    if (!job || !job.delivered) { res.sendStatus(404); return; }
    const status = req.body?.status;
    if (
      !req.body ||
      Object.keys(req.body).some((key) => !["status", "body"].includes(key)) ||
      !Number.isInteger(status) ||
      status < 200 ||
      status > 599
    ) { res.sendStatus(400); return; }
    clearTimeout(job.timer); jobs.delete(job.id);
    job.response.status(status).json(req.body.body);
    res.sendStatus(204);
  });
  return { agents, connector };
}
