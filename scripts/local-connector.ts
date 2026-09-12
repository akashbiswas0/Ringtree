// Run through the private AWS SSM tunnel. Only agent API routes are forwarded.
import { readFileSync } from "node:fs";
const relay = "http://127.0.0.1:4320";
const token = readFileSync(".ringtree/relay-token", "utf8").trim();
const authorization = `Bearer ${token}`;
const local = "http://127.0.0.1:4321";
const routes = new Set(["state", "manifests", "grants", "call"]);
let relayUnavailable = false;
async function worker() {
  while (true) {
    try {
      const response = await fetch(`${relay}/connector/next`, {
        headers: { Authorization: authorization },
        signal: AbortSignal.timeout(30000),
      });
      if (response.status === 204) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      if (!response.ok) throw Error("RELAY_UNAVAILABLE");
      if (relayUnavailable) {
        relayUnavailable = false;
        console.log("AWS relay connected to the local broker.");
      }
      const job = await response.json() as { id: string; path: string; method: string; body?: unknown };
      if (!routes.has(job.path) || !["GET", "POST"].includes(job.method))
        throw Error("RELAY_ROUTE_DENIED");
      let status = 503;
      let body: unknown = { error: "LOCAL_BROKER_UNAVAILABLE" };
      try {
        const result = await fetch(`${local}/api/${job.path}`, {
          method: job.method,
          headers: { "Content-Type": "application/json" },
          body: job.method === "POST" ? JSON.stringify(job.body) : undefined,
          signal: AbortSignal.timeout(240000),
        });
        status = result.status;
        body = await result.json();
      } catch { /* Return a safe error; never log provider data. */ }
      await fetch(`${relay}/connector/result/${job.id}`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: authorization },
        body: JSON.stringify({ status, body }), signal: AbortSignal.timeout(10000),
      });
    } catch {
      if (!relayUnavailable) {
        relayUnavailable = true;
        console.error("Local connector unavailable; retrying.");
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}
console.log("Connecting AWS agents to the local broker through the private relay.");
await Promise.all(Array.from({ length: 4 }, worker));
