import { useEffect, useRef, useState } from "react";
import {
  GitBranch,
  ShieldCheck,
  KeyRound,
  Server,
  ArrowDownRight,
  Activity,
  LockKeyhole,
  Plug,
  ArrowUpRight,
  Check,
  RefreshCw,
  Download,
  SquareTerminal,
  Database,
} from "lucide-react";
import { hexlify, randomBytes, Transaction } from "ethers";
import { LedgerController, deviceError } from "./ledger";
import {
  domain,
  ROOT,
  TOOLS,
  hostTypes,
  typedGrant,
  decisionTypes,
  revokeTypes,
  type Grant,
} from "../shared/protocol";
import { JoinRequest, joinTypes, joinMessage } from "../shared/enrollment";
import type { z } from "zod";
import {
  BASE_SEPOLIA_USDC,
  GRAPH_REWARD_LABEL,
  graphRewardDetails,
} from "../shared/payment";

type Manifest = {
  hostId: string;
  label: string;
  agents: Record<string, string>;
};
type Proposal = {
  id: string;
  digest: string;
  status: string;
  raw: string;
  expiresAt: number;
  hash?: string;
  missionId?: string;
  kind?: "graph-agent-reward";
};
type State = {
  runtime?: string;
  ownerApprovalVersion?: number;
  configured: boolean;
  owner?: string;
  salt?: string;
  ringConfigured: boolean;
  ringReady: boolean;
  graphConfigured: boolean;
  graphReady: boolean;
  model?: string;
  allowBroadcast: boolean;
  keyRingRootId?: string;
  keyRingApplicationPath?: string;
  hosts: Array<{ hostId: string; label: string; active: boolean }>;
  manifests: Manifest[];
  grants: Array<{ grant: Grant; used: number; revoked: boolean }>;
  proposals: Proposal[];
  results: Array<{ id: string; tool: string; result: unknown }>;
  graphMissions: Array<{
    id: string;
    question: string;
    status: "queued" | "running" | "completed" | "failed";
    createdAt: string;
    updatedAt: string;
    error?: string;
    result?: {
      text?: string;
      source?: string;
      live?: boolean;
      mcpCalls?: Array<{ name: string; status: string }>;
      customSubgraph?: {
        endpoint: string;
        blockNumber: number;
        indexedTransfers: string;
        indexedVolume: string;
      };
      x402?: {
        status: "disabled" | "unfunded" | "paid" | "failed";
        balanceUnits?: string;
        paidAmountUnits?: string;
        paymentHash?: string;
      };
    };
    rewardStatus?: "pending" | "approved" | "signed" | "broadcast" | "rejected";
    rewardProposalId?: string;
    paymentHash?: string;
  }>;
  paymentConfigured: boolean;
  paymentReady: boolean;
  paymentAddress?: string;
  events: Array<{
    seq: number;
    at: string;
    type: string;
    reason?: string;
    tool?: string;
    hash: string;
  }>;
};
const nonce = () => hexlify(randomBytes(32));
const now = () => Math.floor(Date.now() / 1000);
const short = (s: string) => s.slice(0, 8) + "…" + s.slice(-6);
const formatCount = (value: string | undefined) => {
  if (!value) return "--";
  try {
    return BigInt(value).toLocaleString("en-US");
  } catch {
    return "--";
  }
};
const readable = (v: unknown) => JSON.stringify(v, null, 2);
async function api(path: string, body?: unknown) {
  const r = await fetch("/api/" + path, {
    method: body ? "POST" : "GET",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error ?? "Request failed");
  return d;
}
function download(name: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([readable(value)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function App() {
  const [state, setState] = useState<State>();
  const [notice, setNotice] = useState(
    "Connect Ledger Flex to authorize your agent team.",
  );
  const [error, setError] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("Workspace");
  const [graphQuestion, setGraphQuestion] = useState("");
  const [graphSubmitting, setGraphSubmitting] = useState(false);
  const [joinRequest, setJoinRequest] = useState<z.infer<typeof JoinRequest>>();
  const controller = useRef<LedgerController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let aborted = false;
    const refresh = async () => {
      try {
        const s = await api("state");
        if (!aborted) setState(s);
      } catch {
        if (!aborted)
          setError(
            "Broker unavailable. Start it with npm run broker, then retry.",
          );
      }
    };
    void refresh();
    const timer = setInterval(refresh, 2500);
    return () => {
      mounted.current = false;
      aborted = true;
      clearInterval(timer);
      void controller.current?.disconnect();
    };
  }, []);
  async function refresh() {
    setState(await api("state"));
  }
  async function perform(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(deviceError(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  function ledger() {
    controller.current ??= new LedgerController(setNotice);
    return controller.current;
  }
  function owner() {
    if (state?.ownerApprovalVersion !== 2)
      throw new Error("Restart the broker with npm run setup -- serve to load readable owner approvals, then refresh this page.");
    if (!address) throw new Error("Connect Ledger Flex first.");
    if (!state?.configured || !state.salt)
      throw new Error(
        "Pin the verified address with npm run setup, then restart the broker.",
      );
    if (address !== state.owner)
      throw new Error("This Ledger address does not match the pinned owner.");
    return state.salt;
  }
  async function enroll(m: Manifest) {
    const salt = owner();
    const host = {
      hostId: m.hostId,
      label: m.label,
      nonce: nonce(),
      expiresAt: now() + 600,
      action: "enroll" as const,
    };
    const signature = await ledger().signPermission({
      domain: domain(salt),
      types: hostTypes,
      primaryType: "HostEnrollment",
      message: host,
    });
    await api("hosts", { host, signature });
    setNotice("Host authorized. Create its root grant to start the workflow.");
  }
  async function root(m: Manifest) {
    const salt = owner();
    const g: Grant = {
      id: nonce(),
      parentId: ROOT,
      issuer: address,
      subject: m.agents.orchestrator,
      hostId: m.hostId,
      tools: [...TOOLS],
      resource: "base-sepolia",
      maxCalls: 16,
      expiresAt: now() + 1800,
      nonce: nonce(),
    };
    const signature = await ledger().signPermission(typedGrant(g, salt));
    await api("grants", { grant: g, signature });
    setNotice(
      "Root grant active. Next, open Graph Agent and submit a mission. A payment approval appears only after the mission completes.",
    );
  }
  async function decide(p: Proposal, decision: "approve" | "reject") {
    const salt = owner();
    const value = {
      requestId: p.id,
      digest: p.digest,
      decision,
      nonce: nonce(),
      expiresAt: Math.min(p.expiresAt, now() + 300),
    };
    const signature = await ledger().signPermission({
      domain: domain(salt),
      types: decisionTypes,
      primaryType: "ActionDecision",
      message: value,
    });
    await api("decision", { decision: value, signature });
    setNotice(
      decision === "approve"
        ? state?.allowBroadcast
          ? "Action approved. Review the exact transaction on Flex; signing will submit it to Base Sepolia."
          : "Action approved. Sign the exact transaction on Flex next."
        : "Action rejected.",
    );
  }
  async function sign(p: Proposal) {
    owner();
    const raw = await ledger().signTransaction(p.raw, state?.paymentAddress);
    if (state?.allowBroadcast) {
      setNotice("Ledger signature verified. Submitting to Base Sepolia…");
      const submitted = await api("submit", { requestId: p.id, raw });
      setNotice(`Signed on Flex and submitted to Base Sepolia: ${submitted.hash}`);
    } else {
      await api("signed", { requestId: p.id, raw });
      setNotice("Transaction signed and verified. Broadcasting is disabled.");
    }
  }
  async function revoke(g: Grant) {
    const salt = owner();
    const payload = { grantId: g.id, nonce: nonce(), expiresAt: now() + 300 };
    const signature = await ledger().signPermission({
      domain: domain(salt),
      types: revokeTypes,
      primaryType: "RevokeGrant",
      message: payload,
    });
    await api("revoke", { payload, signature });
    setNotice(
      "Grant revoked. Its descendants are blocked on their next request.",
    );
  }
  async function removeHost(m: Manifest) {
    const salt = owner();
    const host = {
      hostId: m.hostId,
      label: m.label,
      nonce: nonce(),
      expiresAt: now() + 300,
      action: "revoke" as const,
    };
    const signature = await ledger().signPermission({
      domain: domain(salt),
      types: hostTypes,
      primaryType: "HostEnrollment",
      message: host,
    });
    await api("hosts", { host, signature });
    setNotice(
      "Agent host access revoked. This is separate from removing a Key Ring broker member.",
    );
  }
  async function approveJoin() {
    const salt = owner();
    if (!joinRequest) return;
    const rootId = state?.keyRingRootId,
      applicationPath = state?.keyRingApplicationPath;
    if (!rootId || !applicationPath)
      throw new Error(
        "Add your initialized Key Ring public metadata to the broker config before enrollment.",
      );
    const signature = await ledger().signPermission({
      domain: domain(salt),
      types: joinTypes,
      primaryType: "RingLinkEnrollment",
      message: { ...joinMessage(joinRequest), rootId, applicationPath },
    });
    download("ringlink-approval.json", {
      request: joinRequest,
      owner: address,
      salt,
      signature,
      rootId,
      applicationPath,
    });
    setNotice(
      "Approval downloaded. Run npm run ringlink -- approve <file> on this laptop to add the remote member.",
    );
  }
  async function submitGraphMission(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = graphQuestion.trim();
    if (question.length < 8 || graphSubmitting) return;
    setGraphSubmitting(true);
    setError("");
    try {
      await api("graph/missions", { question });
      setGraphQuestion("");
      setNotice(
        "Graph mission queued. The agent will discover an active Subgraph, verify usage, inspect its schema, and query live data.",
      );
      await refresh();
    } catch (e) {
      setError(deviceError(e));
    } finally {
      setGraphSubmitting(false);
    }
  }
  const pending =
    state?.proposals.filter(
      (p) => p.status === "pending" && p.expiresAt > now(),
    ) ?? [];
  const active = (() => {
    if (!state) return [];
    const grants = new Map(state.grants.map((record) => [record.grant.id, record]));
    const activeHosts = new Set(
      state.hosts.filter((host) => host.active).map((host) => host.hostId),
    );
    const timestamp = now();
    return state.grants.filter((record) => {
      if (
        record.revoked ||
        record.grant.expiresAt <= timestamp ||
        !activeHosts.has(record.grant.hostId)
      )
        return false;
      const seen = new Set<string>();
      let parentId = record.grant.parentId;
      while (parentId !== ROOT) {
        if (seen.has(parentId)) return false;
        seen.add(parentId);
        const parent = grants.get(parentId);
        if (
          !parent ||
          parent.revoked ||
          parent.grant.expiresAt <= timestamp
        )
          return false;
        parentId = parent.grant.parentId;
      }
      return true;
    });
  })();
  const activeRoots = active.filter((record) => record.grant.parentId === ROOT);
  const activeDelegated = active.length - activeRoots.length;
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="logo" href="/">
          <GitBranch aria-hidden />
          RingTree<span>LAB</span>
        </a>
        <div className="workspace-label">YOUR CONTROL PLANE</div>
        <nav aria-label="Dashboard">
          {["Workspace", "Graph Agent", "Approvals", "RingLink", "Activity"].map((name) => (
            <button
              className={tab === name ? "nav active" : "nav"}
              onClick={() => setTab(name)}
              key={name}
            >
              {name === "Workspace" ? (
                <GitBranch aria-hidden />
              ) : name === "Graph Agent" ? (
                <Database aria-hidden />
              ) : name === "Approvals" ? (
                <ShieldCheck aria-hidden />
              ) : name === "RingLink" ? (
                <Server aria-hidden />
              ) : (
                <Activity aria-hidden />
              )}
              {name}
              {name === "Approvals" && pending.length > 0 && (
                <b>{pending.length}</b>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="status-dot" />
          Ledger Agent Stack<p>Owner authority stays on your Flex.</p>
          <span className="mono">BASE SEPOLIA · 84532</span>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>
            RingTree / <strong>{tab}</strong>
          </span>
          <button
            disabled={busy}
            onClick={() =>
              perform(async () => {
                if (address) {
                  await ledger().disconnect();
                  setAddress("");
                  setNotice("Ledger disconnected.");
                } else setAddress(await ledger().connect());
              })
            }
          >
            <Plug size={16} aria-hidden />
            {busy
              ? "Check your Ledger…"
              : address
                ? short(address)
                : "Connect Ledger Flex"}
          </button>
        </header>
        <section className="intro">
          <div>
            <p className="eyebrow">AUTHORITY, BRANCHING SAFELY</p>
            <h1>
              {tab === "Workspace"
                ? "One approval. Clear boundaries."
                : tab === "Graph Agent"
                  ? "Ask live blockchain data."
                : tab === "Approvals"
                  ? "Your decision comes next."
                  : tab === "RingLink"
                    ? "Your Key Ring, beyond USB."
                    : "A record of every boundary."}
            </h1>
            <p className="subtitle">
              {tab === "Workspace"
                ? "Let agents collaborate inside the permissions you sign. Each branch can only narrow its authority."
                : tab === "Graph Agent"
                  ? "Discover active Subgraphs, inspect their schemas, query live data, and return a verified answer."
                : tab === "Approvals"
                  ? "Review the exact action before an agent gains permission to continue."
                  : tab === "RingLink"
                    ? "Enroll an isolated remote broker, then let the official Key Ring CLI use your encrypted credentials."
                    : "Inspect real broker decisions, completed calls, and denied requests."}
            </p>
          </div>
          <div className="network">
            <span className="status-dot" />
            {tab === "Graph Agent"
              ? state?.runtime === "aws-ec2"
                ? "AWS EC2 · The Graph"
                : "Local · The Graph"
              : state?.runtime === "aws-ec2"
                ? "AWS EC2 · Base Sepolia"
                : "Local · Base Sepolia"}
          </div>
        </section>
        <div className="notice" role="status" aria-live="polite">
          <ShieldCheck size={18} aria-hidden />
          <span>{notice}</span>
        </div>
        <p className="subtitle">Owner approvals use readable messages. Review every field on Flex; reject blind-signing or hash-only screens. Transactions require a separate signature.</p>
        {error && (
          <div className="error" role="alert">
            {error}
            <button
              onClick={() =>
                perform(async () => {
                  setError("");
                  await refresh();
                })
              }
            >
              Retry
            </button>
          </div>
        )}
        {!state ? (
          <section className="panel empty">
            Connecting to the RingTree broker…
          </section>
        ) : (
          <>
            {!state.configured && (
              <section className="setup panel">
                <KeyRound aria-hidden />
                <div>
                  <h2>Pin your Ledger owner</h2>
                  <p>
                    Connect Flex above to verify your address, then run{" "}
                    <code>npm run setup</code> in your terminal. Restart the
                    broker after setup.
                  </p>
                  {address && <code className="block">{address}</code>}
                  <p>No private key or seed phrase is requested.</p>
                </div>
              </section>
            )}
            {tab === "Workspace" && (
              <>
                <div className="metrics">
                  <div>
                    <span>Active root grants</span>
                    <strong>{activeRoots.length}</strong>
                    <small>{activeDelegated} narrower agent grants beneath them</small>
                  </div>
                  <div>
                    <span>Waiting for you</span>
                    <strong>{pending.length}</strong>
                    <small>Actions need a Ledger decision</small>
                  </div>
                  <div>
                    <span>Credential backend</span>
                    <strong className="metric-text">wallet-cli ring</strong>
                    <small>
                      {!state.ringConfigured
                        ? "OpenAI key setup pending"
                        : state.ringReady
                          ? "Encrypted key present · broker unlocked"
                          : "Encrypted key present · unlock broker"}
                    </small>
                  </div>
                </div>
                <div className="columns">
                  <section className="panel">
                    <div className="panel-head">
                      <div>
                        <p className="eyebrow">DELEGATION TREE</p>
                        <h2>Your research team</h2>
                      </div>
                      <GitBranch aria-hidden />
                    </div>
                    {state.manifests.length === 0 ? (
                      <div className="empty">
                        <Server size={32} aria-hidden />
                        <h3>No agent team registered</h3>
                        <p>
                          After pinning your owner, initialize separate
                          identities:
                        </p>
                        <code>npm run agent -- init</code>
                        <p>
                          Then start the four agent processes or Docker
                          services.
                        </p>
                      </div>
                    ) : (
                      state.manifests.map((m) => (
                        <div key={m.hostId} className="team">
                          <div className="team-top">
                            <div>
                              <h3>{m.label}</h3>
                              <p className="mono">{short(m.hostId)}</p>
                            </div>
                            <span
                              className={
                                state.hosts.some(
                                  (h) => h.hostId === m.hostId && h.active,
                                )
                                  ? "badge good"
                                  : "badge"
                              }
                            >
                              {state.hosts.some(
                                (h) => h.hostId === m.hostId && h.active,
                              )
                                ? "Authorized"
                                : "Pending enrollment"}
                            </span>
                          </div>
                          <div className="team-actions">
                            {!state.hosts.some(
                              (h) => h.hostId === m.hostId && h.active,
                            ) ? (
                              <button
                                disabled={busy || !address}
                                onClick={() => perform(() => enroll(m))}
                              >
                                Approve host on Flex
                              </button>
                            ) : (
                              <>
                                <button
                                  disabled={busy || !address}
                                  onClick={() => perform(() => root(m))}
                                >
                                  {activeRoots.some(
                                    (record) =>
                                      record.grant.hostId === m.hostId &&
                                      record.grant.subject === m.agents.orchestrator,
                                  )
                                    ? "Renew 30-minute root grant"
                                    : "Sign 30-minute root grant"}
                                </button>
                                <button
                                  className="secondary"
                                  disabled={busy || !address}
                                  onClick={() => perform(() => removeHost(m))}
                                >
                                  Disable AWS host
                                </button>
                              </>
                            )}
                          </div>
                          {Object.entries(m.agents).map(([role, subject]) => {
                            const grants = state.grants.filter(
                              (g) => g.grant.subject === subject,
                            );
                            const current =
                              [...grants]
                                .reverse()
                                .find((record) => active.includes(record)) ??
                              grants[grants.length - 1];
                            const currentActive = current
                              ? active.includes(current)
                              : false;
                            return (
                              <div
                                className={
                                  "agent " +
                                  (role === "orchestrator" ? "parent" : "child")
                                }
                                key={role}
                              >
                                <div className="agent-icon">
                                  {role === "orchestrator" ? (
                                    <GitBranch aria-hidden />
                                  ) : (
                                    <ArrowDownRight aria-hidden />
                                  )}
                                </div>
                                <div className="agent-body">
                                  <h3>
                                    {role === "researcher" ? "Graph Agent" : role}
                                    <span className="mono">
                                      {short(subject)}
                                    </span>
                                  </h3>
                                  <div className="tags">
                                    {current ? (
                                      current.grant.tools.map((t) => (
                                        <span key={t}>{t}</span>
                                      ))
                                    ) : (
                                      <span>Awaiting delegated grant</span>
                                    )}
                                  </div>
                                  {current && (
                                    <small>
                                      {current.used} / {current.grant.maxCalls}{" "}
                                      calls ·{" "}
                                      {current.revoked
                                        ? "Revoked"
                                        : !currentActive
                                          ? "Blocked or expired"
                                        : new Date(
                                            current.grant.expiresAt * 1000,
                                          ).toLocaleTimeString() + " expiry"}
                                    </small>
                                  )}
                                </div>
                                {current && currentActive && (
                                  <button
                                    className="tiny secondary"
                                    disabled={busy || !address}
                                    onClick={() =>
                                      perform(() => revoke(current.grant))
                                    }
                                  >
                                      {role === "orchestrator"
                                        ? "Revoke root + descendants"
                                        : "Revoke"}
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ))
                    )}
                  </section>
                  <aside>
                    <section className="panel">
                      <div className="panel-head">
                        <h2>Security boundaries</h2>
                        <LockKeyhole aria-hidden />
                      </div>
                      <ul className="check-list">
                        <li>
                          <Check aria-hidden />
                          API key stays in the broker
                        </li>
                        <li>
                          <Check aria-hidden />
                          Child scopes must be subsets
                        </li>
                        <li>
                          <Check aria-hidden />
                          Parent budget is shared
                        </li>
                        <li>
                          <Check aria-hidden />
                          Requests bind agent and host
                        </li>
                        <li>
                          <Check aria-hidden />
                          Nonces block replay
                        </li>
                        <li>
                          <Check aria-hidden />
                          Revocation cascades
                        </li>
                      </ul>
                      <p className="footnote">
                        These controls are enforced by server code,
                        independently of model output.
                      </p>
                    </section>
                    <section className="panel">
                      <h2>Live workflow</h2>
                      <ol className="workflow">
                        <li>Ask a natural-language Graph question</li>
                        <li>Query the live ledger-agent Subgraph</li>
                        <li>Discover and verify data through MCP</li>
                        <li>Queue a fixed Graph Agent reward</li>
                        <li>Approve the USDC payment on Flex</li>
                      </ol>
                      <p className="footnote">
                        x402 remains testnet-only and activates after the reward wallet is funded.
                      </p>
                    </section>
                  </aside>
                </div>
                {state.results.length > 0 && (
                  <section className="panel">
                    <div className="panel-head">
                      <h2>Agent findings</h2>
                      <Activity aria-hidden />
                    </div>
                    <p className="footnote">chain.read contains RPC observations. AI research and risk text are advisory—not an audit or authorization.</p>
                    <div className="findings">
                      {state.results.slice(-4).map((r) => (
                        <article key={r.id}>
                          <span className="badge">{r.tool}</span>
                          <pre>
                            {typeof r.result === "object" &&
                            r.result &&
                            "text" in r.result
                              ? String(r.result.text)
                              : readable(r.result)}
                          </pre>
                        </article>
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}
            {tab === "Graph Agent" && (
              <>
                <div className="columns graph-layout">
                  <section className="panel">
                    <div className="panel-head">
                      <div>
                        <p className="eyebrow">LIVE SUBGRAPH MCP</p>
                        <h2>New Graph mission</h2>
                      </div>
                      <span className={state.graphReady ? "badge good" : "badge"}>
                        {!state.graphConfigured
                          ? "Graph key missing"
                          : state.graphReady
                            ? "Ready"
                            : "Broker locked"}
                      </span>
                    </div>
                    <form className="graph-form" onSubmit={submitGraphMission}>
                      <label htmlFor="graph-question">
                        What should the agent investigate?
                      </label>
                      <textarea
                        id="graph-question"
                        value={graphQuestion}
                        onChange={(event) => setGraphQuestion(event.target.value)}
                        placeholder="Summarize recent Base Sepolia USDC activity and compare it with another active Subgraph."
                        maxLength={600}
                        rows={5}
                        aria-describedby="graph-question-help"
                      />
                      <div className="form-help" id="graph-question-help">
                        <span>The answer must use a focused live query.</span>
                        <span>{graphQuestion.length}/600</span>
                      </div>
                      {!state.graphConfigured && (
                        <p className="inline-warning">
                          Configure the Gateway key with <code>npm run setup -- graph-secret</code>.
                        </p>
                      )}
                      {!state.paymentConfigured && (
                        <p className="inline-warning">
                          Create the reward wallet with <code>npm run setup -- payment-wallet</code>.
                        </p>
                      )}
                      {!active.some((item) => item.grant.tools.includes("graph.answer")) && (
                        <p className="inline-warning">
                          Sign a fresh Ledger root grant for the Graph capability.
                        </p>
                      )}
                      <button
                        type="submit"
                        disabled={
                          graphSubmitting ||
                          graphQuestion.trim().length < 8 ||
                          !state.graphReady ||
                          !active.some((item) => item.grant.tools.includes("graph.answer"))
                        }
                        aria-busy={graphSubmitting}
                      >
                        <Database size={16} aria-hidden />
                        {graphSubmitting ? "Queuing mission…" : "Ask Graph Agent"}
                      </button>
                    </form>
                  </section>
                  <aside>
                    <section className="panel">
                      <h2>Required live workflow</h2>
                      <ol className="workflow">
                        <li>Discover relevant Subgraphs</li>
                        <li>Verify 30-day query activity</li>
                        <li>Inspect the selected schema</li>
                        <li>Run a focused live query</li>
                        <li>Explain facts and limitations</li>
                      </ol>
                      <p className="footnote">
                        Graph and OpenAI keys are decrypted only inside the broker through wallet-cli ring.
                      </p>
                    </section>
                  </aside>
                </div>
                <section className="panel">
                  <div className="panel-head">
                    <h2>Mission history</h2>
                    <span className="badge">{state.graphMissions?.length ?? 0} missions</span>
                  </div>
                  {!state.graphMissions?.length ? (
                    <div className="empty graph-empty">
                      <Database size={32} aria-hidden />
                      <h3>No Graph missions yet</h3>
                      <p>Ask a specific protocol, market, wallet, or governance question to begin.</p>
                    </div>
                  ) : (
                    <div className="mission-list">
                      {[...state.graphMissions].reverse().map((mission) => (
                        <article className="mission" key={mission.id}>
                          <div className="team-top">
                            <h3>{mission.question}</h3>
                            <span className={mission.status === "completed" ? "badge good" : "badge"}>
                              {mission.status}
                            </span>
                          </div>
                          {mission.status === "running" && (
                            <p className="mission-progress" role="status">
                              Discovering and querying live Subgraphs…
                            </p>
                          )}
                          {mission.error && (
                            <div className="mission-error" role="alert">
                              <span>{mission.error.replaceAll("_", " ")}</span>
                              <button
                                type="button"
                                className="secondary tiny"
                                onClick={() => setGraphQuestion(mission.question)}
                              >
                                Try again
                              </button>
                            </div>
                          )}
                          {mission.result?.text && (
                            <div className="mission-result">
                              <p>{mission.result.text}</p>
                              <div className="tags" aria-label="MCP tools used">
                                {mission.result.mcpCalls?.map((call, index) => (
                                  <span key={call.name + "-" + index}>{call.name}</span>
                                ))}
                              </div>
                              <small>Live source: {mission.result.source}</small>
                              {mission.result.customSubgraph && (
                                <small className="custom-source">
                                  ledger-agent · block {mission.result.customSubgraph.blockNumber.toLocaleString("en-US")} · {formatCount(mission.result.customSubgraph.indexedTransfers)} indexed transfers
                                </small>
                              )}
                              {mission.result.x402 && (
                                <div className="custom-source">
                                  <small>
                                    x402 query: {mission.result.x402.status}
                                    {mission.result.x402.paidAmountUnits
                                      ? ` · ${mission.result.x402.paidAmountUnits} atomic USDC`
                                      : ""}
                                  </small>
                                  {mission.result.x402.paymentHash && (
                                    <a
                                      href={
                                        "https://sepolia.basescan.org/tx/" +
                                        mission.result.x402.paymentHash
                                      }
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      View x402 payment
                                      <ArrowUpRight size={14} aria-hidden />
                                    </a>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                          {mission.rewardStatus && (
                            <div className="reward-status">
                              <strong>Agent reward</strong>
                              <span>{GRAPH_REWARD_LABEL} · {mission.rewardStatus}</span>
                              {mission.paymentHash && (
                                <a
                                  href={"https://sepolia.basescan.org/tx/" + mission.paymentHash}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  View payment
                                  <ArrowUpRight size={14} aria-hidden />
                                </a>
                              )}
                            </div>
                          )}
                          <small className="mission-time">
                            {new Date(mission.updatedAt).toLocaleString()}
                          </small>
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              </>
            )}
            {tab === "Approvals" && (
              <section className="panel">
                <div className="panel-head">
                  <h2>Action queue</h2>
                  <span className="badge">
                    {state.allowBroadcast
                      ? "Testnet broadcast enabled"
                      : "Sign only"}
                  </span>
                </div>
                {state.allowBroadcast && (
                  <p className="broadcast-warning" role="status">
                    Broadcasting is enabled. Signing a pending reward submits it to Base Sepolia immediately.
                  </p>
                )}
                {!state.proposals.length ? (
                  <div className="empty">
                    <ShieldCheck size={32} aria-hidden />
                    <h3>No pending actions</h3>
                    <p>
                      The executor queues one fixed reward after a Graph mission completes.
                    </p>
                  </div>
                ) : (
                  state.proposals.map((p) => {
                    const tx = Transaction.from(p.raw);
                    const reward =
                      p.kind === "graph-agent-reward" && state.paymentAddress
                        ? graphRewardDetails(p.raw, state.paymentAddress)
                        : undefined;
                    return (
                      <article className="proposal" key={p.id}>
                        <div className="team-top">
                          <h3>{reward ? "Graph Agent mission reward" : "Legacy transaction"}</h3>
                          <span className="badge">
                            {p.expiresAt <= now() ? "Expired" : p.status}
                          </span>
                        </div>
                        <dl>
                          <dt>Network</dt>
                          <dd>Base Sepolia</dd>
                          <dt>Token contract</dt>
                          <dd className="mono">{reward ? BASE_SEPOLIA_USDC : tx.to}</dd>
                          <dt>Recipient</dt>
                          <dd className="mono">{reward?.recipient ?? tx.to}</dd>
                          <dt>Amount</dt>
                          <dd className="mono tabular-nums">{reward ? GRAPH_REWARD_LABEL : "Legacy"}</dd>
                          <dt>Mission</dt>
                          <dd className="mono">{p.missionId ?? "Not linked"}</dd>
                          <dt>Nonce</dt>
                          <dd>{tx.nonce}</dd>
                          <dt>Gas limit</dt>
                          <dd>{tx.gasLimit.toString()}</dd>
                          <dt>Max fee / gas</dt>
                          <dd>{tx.maxFeePerGas?.toString()} wei</dd>
                          <dt>Approval expiry</dt>
                          <dd>
                            {new Date(p.expiresAt * 1000).toLocaleTimeString()}
                          </dd>
                          <dt>Payload digest</dt>
                          <dd className="mono">{p.digest}</dd>
                        </dl>
                        <div className="team-actions">
                          {p.status === "pending" && (
                            <>
                              <button
                                disabled={
                                  busy || !address || p.expiresAt <= now()
                                }
                                onClick={() =>
                                  perform(() =>
                                    state.allowBroadcast
                                      ? sign(p)
                                      : decide(p, "approve"),
                                  )
                                }
                              >
                                {state.allowBroadcast
                                  ? "Review, sign and broadcast on Flex"
                                  : "Approve action on Flex"}
                              </button>
                              <button
                                className="secondary"
                                disabled={busy || !address}
                                onClick={() =>
                                  perform(() => decide(p, "reject"))
                                }
                              >
                                Reject
                              </button>
                            </>
                          )}
                          {p.status === "approved" && (
                            <button
                              disabled={
                                busy || !address || p.expiresAt <= now()
                              }
                              onClick={() => perform(() => sign(p))}
                            >
                              {state.allowBroadcast
                                ? "Review, sign and broadcast on Flex"
                                : "Sign transaction on Flex"}
                            </button>
                          )}
                          {p.status === "signed" && state.allowBroadcast && (
                            <button
                              disabled={busy || p.expiresAt <= now()}
                              onClick={() =>
                                perform(async () => {
                                  await api("broadcast", { requestId: p.id });
                                  setNotice(
                                    "Signed transaction submitted to Base Sepolia.",
                                  );
                                })
                              }
                            >
                              Resume Base Sepolia broadcast
                            </button>
                          )}
                          {p.hash && p.status !== "broadcast" && (
                            <p className="footnote">
                              {p.expiresAt <= now()
                                ? "Expired signed transaction—not broadcast. It is retained for audit history and cannot be submitted."
                                : "Submission was interrupted. The verified signature is retained; use Resume Base Sepolia broadcast."}{" "}
                              Transaction hash: <span className="mono">{p.hash}</span>
                            </p>
                          )}
                          {p.hash && p.status === "broadcast" && (
                            <a
                              className="button secondary"
                              href={"https://sepolia.basescan.org/tx/" + p.hash}
                              target="_blank"
                              rel="noreferrer"
                            >
                              View submitted transaction
                              <ArrowUpRight size={14} aria-hidden />
                            </a>
                          )}
                        </div>
                      </article>
                    );
                  })
                )}
              </section>
            )}
            {tab === "RingLink" && (
              <>
                <div className="columns">
                  <section className="panel">
                    <div className="panel-head">
                      <h2>Remote broker enrollment</h2>
                      <Server aria-hidden />
                    </div>
                    <p>
                      On the VPS, run <code>npm run ringlink -- request</code>.
                      Transfer the public request to this laptop and import it
                      below.
                    </p>
                    <label className="file-label" htmlFor="join-file">
                      Public enrollment request (JSON)
                    </label>
                    <input
                      id="join-file"
                      type="file"
                      accept=".json,application/json"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file)
                          void perform(async () => {
                            if (file.size > 16000)
                              throw new Error("Enrollment file is too large.");
                            setJoinRequest(
                              JoinRequest.parse(JSON.parse(await file.text())),
                            );
                          });
                      }}
                    />
                    {joinRequest && (
                      <>
                        <dl>
                          <dt>Broker</dt>
                          <dd>{joinRequest.name}</dd>
                          <dt>Member public key</dt>
                          <dd className="mono">{joinRequest.memberPubkey}</dd>
                          <dt>Expires</dt>
                          <dd>
                            {new Date(
                              joinRequest.expiresAt * 1000,
                            ).toLocaleString()}
                          </dd>
                        </dl>
                        <button
                          disabled={busy || !address}
                          onClick={() => perform(approveJoin)}
                        >
                          <Download size={16} aria-hidden />
                          Sign enrollment and download
                        </button>
                      </>
                    )}
                    <p className="footnote">
                      After approval, the laptop controller adds a KEY_READER
                      member. The VPS imports it into an isolated wallet-cli
                      profile and decrypts with wallet-cli ring. Agents are
                      never Key Ring members.
                    </p>
                  </section>
                  <section className="panel">
                    <h2>Official CLI credential path</h2>
                    <ol className="workflow">
                      <li>Owner initializes Key Ring on Ledger</li>
                      <li>CLI encrypts the OpenAI API key</li>
                      <li>Remote broker joins the trustchain</li>
                      <li>CLI decrypts inside the broker process</li>
                      <li>Broker calls OpenAI and returns text</li>
                    </ol>
                    <p className="footnote">
                      Same-ring membership is a broad cryptographic trust
                      boundary. Enroll only broker hosts you administer.
                      Removing membership requires Key Ring rotation and
                      credential rotation where exposure is suspected.
                    </p>
                  </section>
                </div>
                <section className="panel">
                  <h2>Local setup</h2>
                  <div className="command">
                    <SquareTerminal aria-hidden />
                    <code>npm run setup -- secret</code>
                  </div>
                  <p>
                    Enter your API key privately in the terminal. The value is
                    piped directly to wallet-cli ring encrypt.
                  </p>
                  <div className="command">
                    <SquareTerminal aria-hidden />
                    <code>npm run setup -- serve</code>
                  </div>
                  <p>
                    Unlock the broker for this session without putting the
                    password in shell history.
                  </p>
                </section>
              </>
            )}
            {tab === "Activity" && (
              <section className="panel">
                <div className="panel-head">
                  <h2>Broker decision log</h2>
                  <button
                    className="secondary"
                    onClick={() =>
                      download("ringtree-events.json", state.events)
                    }
                  >
                    <Download size={16} aria-hidden />
                    Export
                  </button>
                </div>
                {state.events.length === 0 ? (
                  <div className="empty">
                    <Activity size={32} aria-hidden />
                    <h3>No events yet</h3>
                    <p>
                      Authorize a host to begin. Only real broker activity
                      appears here.
                    </p>
                  </div>
                ) : (
                  <div className="events">
                    {state.events.map((e) => (
                      <article key={e.seq}>
                        <span
                          className={
                            e.type === "DENIED" || e.type === "CALL_FAILED"
                              ? "event-dot denied"
                              : "event-dot"
                          }
                        />
                        <div>
                          <strong>{e.type.replaceAll("_", " ")}</strong>
                          <p>{e.reason ?? e.tool ?? "Recorded by RingTree"}</p>
                          <small className="mono">{short(e.hash)}</small>
                        </div>
                        <time>{new Date(e.at).toLocaleTimeString()}</time>
                      </article>
                    ))}
                  </div>
                )}
                <p className="footnote">
                  Events are hash-linked in SQLite. This detects edits against a
                  saved hash; it does not protect against a broker administrator
                  rewriting the whole log.
                </p>
              </section>
            )}
          </>
        )}
        <footer>
          <span>RingTree MVP · Ledger DMK + wallet-cli ring</span>
          <span>
            Hardware verification and remote enrollment require your device
            setup.
          </span>
        </footer>
      </main>
    </div>
  );
}
