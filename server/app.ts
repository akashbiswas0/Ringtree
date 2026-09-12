import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { hexlify, randomBytes, Transaction } from "ethers";
import { Authority, type GrantRecord, type HostRecord } from "./authority";
import { Store } from "./store";
import { type Config } from "./config";
import {
  CallSchema,
  DecisionSchema,
  HostSchema,
  SignedGrantSchema,
  Hash,
  SignatureSchema,
  Address,
  domain,
  digest,
  ROOT,
  grantTypes,
  hostTypes,
  callTypes,
  decisionTypes,
} from "../shared/protocol";
import { inputSchemas, type ToolProvider } from "./tools";
import type { SecretProvider } from "./secrets";

const id = () => hexlify(randomBytes(32));
type Proposal = {
  id: string;
  grantId: string;
  agent: string;
  raw: string;
  digest: string;
  status:
    | "pending"
    | "approved"
    | "rejected"
    | "signed"
    | "broadcasting"
    | "broadcast"
    | "failed";
  expiresAt: number;
  hash?: string;
  signedRaw?: string;
  missionId?: string;
  kind?: "graph-agent-reward";
};
type GraphMission = {
  id: string;
  question: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  error?: string;
  rewardStatus?: "pending" | "approved" | "signed" | "broadcast" | "rejected";
  rewardProposalId?: string;
  paymentHash?: string;
};
const ManifestSchema = z
  .object({
    hostId: Address,
    label: z.string().min(1).max(48),
    agents: z
      .object({
        orchestrator: Address,
        researcher: Address,
        risk: Address.optional(),
        executor: Address,
      })
      .strict(),
    proof: SignatureSchema,
  })
  .strict();

export type BroadcastProvider = (signedRaw: string) => Promise<string>;
const liveBroadcast: BroadcastProvider = async (signedRaw) => {
  const call = async (method: string, params: unknown[]) => {
    const response = await fetch("https://sepolia.base.org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("BROADCAST_FAILED");
    return (await response.json()) as { result?: unknown; error?: unknown };
  };
  const expectedHash = Transaction.from(signedRaw).hash!;
  const sent = await call("eth_sendRawTransaction", [signedRaw]);
  if (sent.result === expectedHash) return expectedHash;
  // A timeout/retry may surface "already known" or "nonce too low" even when
  // the exact signed transaction reached the network. Confirm by its hash.
  const found = await call("eth_getTransactionByHash", [expectedHash]);
  if (
    found.result &&
    typeof found.result === "object" &&
    (found.result as { hash?: string }).hash === expectedHash
  )
    return expectedHash;
  throw new Error("BROADCAST_FAILED");
};

export function createApp(
  store: Store,
  config: Config | undefined,
  tools: ToolProvider,
  secret: SecretProvider,
  broadcast: BroadcastProvider = liveBroadcast,
) {
  const app = express();
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "default-src": ["'self'"],
          "script-src": ["'self'"],
          "style-src": ["'self'", "'unsafe-inline'"],
          "connect-src": [
            "'self'",
            "https://*.ledger.com",
            "https://*.ledger-test.com",
            "https://sepolia.base.org",
            "wss://*.ledger.com",
          ],
          "img-src": ["'self'", "data:"],
        },
      },
    }),
  );
  app.use(express.json({ limit: "32kb" }));
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    next();
  });
  app.use(
    "/api",
    rateLimit({
      windowMs: 60000,
      limit: 180,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  // The operator dashboard is served locally or over an SSH tunnel. Reject DNS rebinding/CSRF.
  app.use((req, res, next) => {
    const host = req.hostname;
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) {
      res.status(403).json({ error: "LOCAL_TUNNEL_REQUIRED" });
      return;
    }
    const origin = req.get("Origin");
    if (origin) {
      try {
        const parsed = new URL(origin);
        if (
          parsed.protocol !== "http:" ||
          !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
        )
          throw new Error("foreign origin");
      } catch {
        res.status(403).json({ error: "ORIGIN_DENIED" });
        return;
      }
    }
    next();
  });
  const auth: Authority = new Authority(
    store,
    config?.owner ?? "0x0000000000000000000000000000000000000000",
    config?.salt ?? ROOT,
  );
  auth.reconcileDuplicateRoots();
  const grants = () =>
    store
      .all<GrantRecord>("grant")
      .map((record) => ({ ...record, used: store.used(record.grant.id) }));
  const proposals = () =>
    store
      .all<Proposal>("proposal")
      .map(({ signedRaw, ...proposal }) => proposal);
  const graphMissions = () => store.all<GraphMission>("graph-mission");
  app.get("/api/state", (_req, res) =>
    res.json({
      configured: !!config,
      ownerApprovalVersion: 2,
      owner: config?.owner,
      salt: config?.salt,
      model: config?.model,
      ringConfigured: secret.ready(),
      ringReady: secret.unlocked(),
      graphConfigured: tools.graphStatus?.().configured ?? false,
      graphReady: tools.graphStatus?.().ready ?? false,
      paymentConfigured: tools.paymentStatus?.().configured ?? false,
      paymentReady: tools.paymentStatus?.().ready ?? false,
      paymentAddress: tools.paymentStatus?.().address,
      allowBroadcast: config?.allowBroadcast ?? false,
      hosts: store.all<HostRecord>("host"),
      manifests: store.all("manifest"),
      grants: grants(),
      proposals: proposals(),
      graphMissions: graphMissions(),
      events: store.events(),
    }),
  );
  // The AWS relay exposes only this state route. Agents receive the
  // scheduling data required to exercise signed capabilities—not owner UI,
  // payment, proposal payload, provider, or audit-log details.
  app.get("/api/agent-state", (_req, res) =>
    res.json({
      configured: !!config,
      salt: config?.salt,
      graphReady: tools.graphStatus?.().ready ?? false,
      grants: store.all<GrantRecord>("grant").map(({ grant, revoked }) => ({
        grant,
        revoked,
      })),
      graphMissions: graphMissions().map(
        ({ id, question, status, rewardProposalId }) => ({
          id,
          question,
          status,
          rewardProposalId,
        }),
      ),
      proposals: proposals().map(({ kind, status, expiresAt }) => ({
        kind,
        status,
        expiresAt,
      })),
    }),
  );
  app.get("/api/protocol", (_req, res) =>
    res.json({
      domain: config ? domain(config.salt) : null,
      ownerApprovalVersion: 2,
      ownerSignatureScheme: "eip191-ringtree-text-v2",
      agentSignatureScheme: "eip712",
      grantTypes,
      hostTypes,
      callTypes,
      decisionTypes,
    }),
  );
  app.use("/api", (_req, _res, next) => {
    if (!config) throw new Error("RUN_SETUP_FIRST");
    next();
  });
  app.post("/api/hosts", (req, res) => {
    const b = z
      .object({ host: HostSchema, signature: SignatureSchema })
      .strict()
      .parse(req.body);
    auth.host(b.host, b.signature);
    res.json({ ok: true });
  });
  app.post("/api/manifests", (req, res) => {
    const m = ManifestSchema.parse(req.body);
    const { proof, ...unsigned } = m;
    const types = { AgentManifest: [{ name: "digest", type: "bytes32" }] };
    auth.check(
      auth.signer(types, { digest: digest(unsigned) }, proof) === m.hostId,
      "HOST_SIGNATURE_REQUIRED",
    );
    auth.check(
      !store.get("manifest", m.hostId) ||
        digest(store.get("manifest", m.hostId)) === digest(m),
      "MANIFEST_ALREADY_REGISTERED",
    );
    store.put("manifest", m.hostId, m);
    res.json({ ok: true });
  });
  app.post("/api/grants", (req, res) => {
    const b = SignedGrantSchema.parse(req.body);
    auth.add(b.grant, b.signature);
    res.json({ ok: true });
  });
  app.post("/api/revoke", (req, res) => {
    const b = z
      .object({
        payload: z
          .object({ grantId: Hash, nonce: Hash, expiresAt: z.number().int() })
          .strict(),
        signature: SignatureSchema,
      })
      .strict()
      .parse(req.body);
    auth.revoke(b.payload, b.signature);
    res.json({ ok: true });
  });
  app.post("/api/graph/missions", (req, res) => {
    const { question } = z
      .object({ question: z.string().trim().min(8).max(600) })
      .strict()
      .parse(req.body);
    auth.check(tools.graphStatus?.().configured, "GRAPH_KEY_NOT_CONFIGURED");
    auth.check(tools.graphStatus?.().ready, "KEY_RING_UNLOCK_REQUIRED");
    const pending = store
      .all<GraphMission>("graph-mission")
      .filter((mission) => ["queued", "running"].includes(mission.status));
    auth.check(pending.length < 5, "GRAPH_MISSION_LIMIT");
    const createdAt = new Date().toISOString();
    const mission: GraphMission = {
      id: id(),
      question,
      status: "queued",
      createdAt,
      updatedAt: createdAt,
    };
    store.put("graph-mission", mission.id, mission);
    store.event("GRAPH_MISSION_QUEUED", { missionId: mission.id });
    res.json({ mission });
  });
  app.post("/api/call", async (req, res) => {
    const c = CallSchema.parse(req.body);
    // Validate tool and input before reserving an authorization; arbitrary URLs/commands never reach a provider.
    const schema = inputSchemas[c.tool as keyof typeof inputSchemas];
    if (!schema) throw new Error("TOOL_DENIED");
    schema.parse(c.input);
    const graphMission =
      c.tool === "graph.answer"
        ? store.get<GraphMission>("graph-mission", String(c.input.missionId))
        : undefined;
    const rewardMission =
      c.tool === "tx.prepare" && c.input.missionId
        ? store.get<GraphMission>("graph-mission", String(c.input.missionId))
        : undefined;
    if (c.tool === "graph.answer") {
      auth.check(graphMission?.status === "queued", "GRAPH_MISSION_NOT_QUEUED");
      auth.check(
        graphMission.question === c.input.question,
        "GRAPH_MISSION_CHANGED",
      );
    }
    if (c.tool === "tx.prepare" && c.input.missionId) {
      auth.check(rewardMission?.status === "completed", "MISSION_NOT_COMPLETED");
      auth.check(!rewardMission.rewardProposalId, "MISSION_REWARD_EXISTS");
      auth.check(
        !store.all<Proposal>("proposal").some(
          (proposal) =>
            proposal.kind === "graph-agent-reward" &&
            ["pending", "approved", "signed", "broadcasting"].includes(
              proposal.status,
            ) &&
            proposal.expiresAt > auth.now(),
        ),
        "REWARD_ALREADY_PENDING",
      );
      auth.check(tools.paymentStatus?.().ready, "PAYMENT_WALLET_NOT_CONFIGURED");
    }
    const grant = auth.consume(c);
    try {
      if (c.tool === "tx.prepare") {
        const proposalId = id();
        const raw = await tools.prepare(proposalId, c.input);
        auth.chain(grant.id); // Revocation may occur during network I/O.
        const p: Proposal = {
          id: proposalId,
          grantId: grant.id,
          agent: grant.subject,
          raw,
          digest: Transaction.from(raw).unsignedHash,
          status: "pending",
          expiresAt: auth.now() + 600,
          ...(rewardMission
            ? {
                missionId: rewardMission.id,
                kind: "graph-agent-reward" as const,
              }
            : {}),
        };
        store.put("proposal", p.id, p);
        store.event("APPROVAL_REQUESTED", {
          requestId: p.id,
          grantId: grant.id,
          digest: p.digest,
        });
        if (rewardMission) {
          store.put("graph-mission", rewardMission.id, {
            ...rewardMission,
            rewardStatus: "pending",
            rewardProposalId: p.id,
            updatedAt: new Date().toISOString(),
          });
          store.event("AGENT_REWARD_REQUESTED", {
            missionId: rewardMission.id,
            requestId: p.id,
          });
        }
        res.json({ proposal: p });
        return;
      }
      if (graphMission) {
        store.put("graph-mission", graphMission.id, {
          ...graphMission,
          status: "running",
          updatedAt: new Date().toISOString(),
        });
        store.event("GRAPH_MISSION_STARTED", {
          missionId: graphMission.id,
          grantId: grant.id,
        });
      }
      const result = await tools.execute(c.tool, c.input);
      auth.chain(grant.id);
      const rootId = auth.chain(grant.id).at(-1)!.grant.id;
      store.put("result", c.nonce, {
        id: c.nonce,
        rootId,
        tool: c.tool,
        subject: grant.subject,
        result,
        at: new Date().toISOString(),
      });
      store.event("CALL_COMPLETED", { tool: c.tool, grantId: grant.id });
      if (graphMission) {
        store.put("graph-mission", graphMission.id, {
          ...graphMission,
          status: "completed",
          updatedAt: new Date().toISOString(),
          result,
        });
        store.event("GRAPH_MISSION_COMPLETED", {
          missionId: graphMission.id,
        });
      }
      res.json({ result });
    } catch (error) {
      store.event("CALL_FAILED", { tool: c.tool, grantId: grant.id });
      if (graphMission) {
        const reason =
          error instanceof Error && /^[A-Z_]+$/.test(error.message)
            ? error.message
            : "GRAPH_MISSION_FAILED";
        store.put("graph-mission", graphMission.id, {
          ...graphMission,
          status: "failed",
          updatedAt: new Date().toISOString(),
          error: reason,
        });
        store.event("GRAPH_MISSION_FAILED", {
          missionId: graphMission.id,
          reason,
        });
      }
      throw error;
    }
  });
  app.post("/api/decision", (req, res) => {
    const b = z
      .object({ decision: DecisionSchema, signature: SignatureSchema })
      .strict()
      .parse(req.body);
    store.atomic(() => {
      const p = store.get<Proposal>("proposal", b.decision.requestId);
      auth.check(p && p.status === "pending", "PROPOSAL_NOT_PENDING");
      auth.check(p.expiresAt > auth.now(), "PROPOSAL_EXPIRED");
      auth.chain(p.grantId);
      auth.check(p.digest === b.decision.digest, "PAYLOAD_CHANGED");
      auth.decision(b.decision, b.signature);
      p.status = b.decision.decision === "approve" ? "approved" : "rejected";
      p.expiresAt = Math.min(p.expiresAt, b.decision.expiresAt);
      store.put("proposal", p.id, p);
      if (p.missionId) {
        const mission = store.get<GraphMission>("graph-mission", p.missionId);
        if (mission)
          store.put("graph-mission", mission.id, {
            ...mission,
            rewardStatus: p.status,
            updatedAt: new Date().toISOString(),
          });
      }
      store.event("HUMAN_" + p.status.toUpperCase(), { requestId: p.id });
    });
    res.json({ ok: true });
  });
  app.post("/api/signed", (req, res) => {
    const b = z
      .object({
        requestId: Hash,
        raw: z
          .string()
          .regex(/^0x[0-9a-fA-F]+$/)
          .max(4000),
      })
      .strict()
      .parse(req.body);
    store.atomic(() => {
      const p = store.get<Proposal>("proposal", b.requestId);
      auth.check(p && p.status === "approved", "PROPOSAL_NOT_APPROVED");
      auth.check(p.expiresAt > auth.now(), "PROPOSAL_EXPIRED");
      auth.chain(p.grantId);
      const tx = Transaction.from(b.raw);
      auth.check(
        tx.isSigned() &&
          tx.from === config!.owner &&
          tx.unsignedSerialized === p.raw,
        "TRANSACTION_MISMATCH",
      );
      store.once(tx.hash!);
      const signedProposal = {
        ...p,
        status: "signed",
        hash: tx.hash,
        signedRaw: b.raw,
      } as const;
      store.put("proposal", p.id, signedProposal);
      if (p.missionId) {
        const mission = store.get<GraphMission>("graph-mission", p.missionId);
        if (mission)
          store.put("graph-mission", mission.id, {
            ...mission,
            rewardStatus: "signed",
            paymentHash: tx.hash!,
            updatedAt: new Date().toISOString(),
          });
      }
      store.event("TRANSACTION_SIGNED", { requestId: p.id, hash: tx.hash });
    });
    res.json({ ok: true });
  });
  app.post("/api/submit", async (req, res) => {
    auth.check(config!.allowBroadcast, "BROADCAST_DISABLED");
    const b = z
      .object({
        requestId: Hash,
        raw: z.string().regex(/^0x[0-9a-fA-F]+$/).max(4000),
      })
      .strict()
      .parse(req.body);
    const signed = store.atomic(() => {
      const p = store.get<Proposal>("proposal", b.requestId);
      auth.check(
        p && (p.status === "pending" || p.status === "approved"),
        "PROPOSAL_NOT_APPROVABLE",
      );
      auth.check(p.expiresAt > auth.now(), "PROPOSAL_EXPIRED");
      auth.chain(p.grantId);
      const tx = Transaction.from(b.raw);
      auth.check(
        tx.isSigned() &&
          tx.from === config!.owner &&
          tx.unsignedSerialized === p.raw,
        "TRANSACTION_MISMATCH",
      );
      store.once(tx.hash!);
      const next = {
        ...p,
        status: "broadcasting" as const,
        hash: tx.hash!,
        signedRaw: b.raw,
      };
      store.put("proposal", p.id, next);
      if (p.status === "pending")
        store.event("ACTION_APPROVED_BY_TRANSACTION_SIGNATURE", {
          requestId: p.id,
          hash: tx.hash,
        });
      store.event("TRANSACTION_SIGNED", { requestId: p.id, hash: tx.hash });
      return next;
    });
    try {
      const hash = await broadcast(signed.signedRaw!);
      if (hash !== signed.hash) throw new Error("BROADCAST_FAILED");
      store.put("proposal", signed.id, { ...signed, status: "broadcast" });
      if (signed.missionId) {
        const mission = store.get<GraphMission>("graph-mission", signed.missionId);
        if (mission)
          store.put("graph-mission", mission.id, {
            ...mission,
            rewardStatus: "broadcast",
            paymentHash: hash,
            updatedAt: new Date().toISOString(),
          });
      }
      store.event("TRANSACTION_BROADCAST", { hash });
      res.json({ hash });
    } catch {
      // Keep the verified signature so an uncertain network result can be
      // reconciled or retried without asking the Ledger to sign again.
      store.put("proposal", signed.id, { ...signed, status: "signed" });
      throw new Error("BROADCAST_UNCERTAIN_CHECK_EXPLORER");
    }
  });
  app.post("/api/broadcast", async (req, res) => {
    auth.check(config!.allowBroadcast, "BROADCAST_DISABLED");
    const { requestId } = z
      .object({ requestId: Hash })
      .strict()
      .parse(req.body);
    const p = store.atomic(() => {
      const p = store.get<Proposal>("proposal", requestId);
      auth.check(
        p && p.status === "signed" && p.signedRaw,
        "PROPOSAL_NOT_SIGNED",
      );
      auth.check(p.expiresAt > auth.now(), "PROPOSAL_EXPIRED");
      auth.chain(p.grantId);
      store.put("proposal", p.id, { ...p, status: "broadcasting" });
      return p;
    });
    try {
      const hash = await broadcast(p.signedRaw!);
      if (hash !== p.hash) throw new Error("BROADCAST_FAILED");
      store.put("proposal", p.id, { ...p, status: "broadcast" });
      if (p.missionId) {
        const mission = store.get<GraphMission>("graph-mission", p.missionId);
        if (mission)
          store.put("graph-mission", mission.id, {
            ...mission,
            rewardStatus: "broadcast",
            paymentHash: p.hash,
            updatedAt: new Date().toISOString(),
          });
      }
      store.event("TRANSACTION_BROADCAST", { hash: p.hash });
      res.json({ hash: p.hash });
    } catch {
      store.put("proposal", p.id, { ...p, status: "signed" });
      throw new Error("BROADCAST_UNCERTAIN_CHECK_EXPLORER");
    }
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "ROUTE_NOT_FOUND" }),
  );
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const reason =
        error instanceof z.ZodError
          ? "INVALID_INPUT"
          : error instanceof Error && /^[A-Z_]+$/.test(error.message)
            ? error.message
            : "REQUEST_FAILED";
      store.event("DENIED", { reason });
      res
        .status(reason === "KEY_RING_SECRET_NOT_CONFIGURED" ? 503 : 400)
        .json({ error: reason });
    },
  );
  return app;
}
