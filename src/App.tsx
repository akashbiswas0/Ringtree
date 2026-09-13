import { useEffect, useRef, useState } from "react";
import {
  GitBranch,
  ShieldCheck,
  KeyRound,
  Server,
  ArrowDownRight,
  Activity,
  ChevronDown,
  Plug,
  ArrowUpRight,
  Check,
  Download,
  Database,
} from "lucide-react";
import { hexlify, randomBytes, Transaction } from "ethers";
import { LedgerController, deviceError } from "./ledger";
import { OWNER_APPROVAL_VERSION } from "../shared/owner-approval";
import {
  formatCount,
  formatPercentChange,
  formatStableAtomic,
} from "./format";
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
  ownerApprovalVersion?: number;
  configured: boolean;
  owner?: string;
  salt?: string;
  ringConfigured: boolean;
  ringReady: boolean;
  graphConfigured: boolean;
  graphReady: boolean;
  allowBroadcast: boolean;
  hosts: Array<{ hostId: string; label: string; active: boolean }>;
  manifests: Manifest[];
  grants: Array<{ grant: Grant; used: number; revoked: boolean }>;
  proposals: Proposal[];
  graphMissions: Array<{
    id: string;
    owner?: string;
    question: string;
    status: "queued" | "running" | "completed" | "failed";
    createdAt: string;
    updatedAt: string;
    error?: string;
    result?: {
      text?: string;
      source?: string;
      live?: boolean;
      analysisMode?: "standardized-defi" | "general-live-data";
      mcpCalls?: Array<{
        name: string;
        status: string;
        identifier?: string;
        query?: string;
        argumentsHash?: string;
        outputHash?: string;
        outputBytes?: number;
        standardizedSchema?: boolean;
        max30DayQueryCount?: string;
      }>;
      customSubgraph?: {
        endpoint: string;
        blockNumber: number;
        blockTimestamp?: number;
        freshnessSeconds?: number;
        indexedTransfers: string;
        indexedVolume: string;
        indexedVolumeUsdc?: string;
        enhancedSnapshots?: boolean;
        latest24Hours?: {
          fromTimestamp: number;
          toTimestamp: number;
          observedBuckets: number;
          transferCount: string;
          volumeUnits: string;
          volumeUsdc: string;
          maxTransferUnits: string;
          maxTransferUsdc: string;
          largeTransferCount: string;
          whaleTransferCount: string;
          whaleVolumeUnits: string;
          whaleVolumeUsdc: string;
        };
        previous24Hours?: {
          volumeUnits: string;
          transferCount: string;
        };
        volumeChangePercent?: string;
        transferCountChangePercent?: string;
      };
      x402?: {
        status:
          | "disabled"
          | "unfunded"
          | "paid"
          | "failed"
          | "budget-exhausted"
          | "duplicate-blocked"
          | "circuit-open";
        subgraphId?: string;
        queryHash?: string;
        dailyBudgetUnits?: string;
        dailySpentUnits?: string;
        balanceUnits?: string;
        paidAmountUnits?: string;
        paymentHash?: string;
        blockNumber?: number;
        blockTimestamp?: number;
        freshnessSeconds?: number;
        reason?: string;
        reused?: boolean;
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
const readable = (v: unknown) => JSON.stringify(v, null, 2);
async function api(path: string, body?: unknown) {
  const r = await fetch("/api/" + path, {
    method: body ? "POST" : "GET",
    cache: "no-store",
    ...(path === "state" ? { signal: AbortSignal.timeout(5000) } : {}),
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
  const [brokerOnline, setBrokerOnline] = useState(false);
  const [brokerError, setBrokerError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("Workspace");
  const [graphQuestion, setGraphQuestion] = useState("");
  const [graphSubmitting, setGraphSubmitting] = useState(false);
  const controller = useRef<LedgerController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let aborted = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const s = await api("state");
        if (!aborted) {
          setState(s);
          setBrokerOnline(true);
          setBrokerError("");
        }
      } catch {
        if (!aborted) {
          setBrokerOnline(false);
          setBrokerError("Broker offline. Run npm run setup -- serve to reconnect.");
        }
      } finally {
        if (!aborted) timer = setTimeout(poll, 2500);
      }
    };
    void poll();
    return () => {
      mounted.current = false;
      aborted = true;
      clearTimeout(timer);
      void controller.current?.disconnect();
    };
  }, []);
  async function refresh() {
    try {
      const next = await api("state");
      if (!mounted.current) return;
      setState(next);
      setBrokerOnline(true);
      setBrokerError("");
    } catch {
      if (!mounted.current) return;
      setBrokerOnline(false);
      setBrokerError("Broker offline. Run npm run setup -- serve to reconnect.");
    }
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
    controller.current ??= new LedgerController(setNotice, () => {
      if (mounted.current) setAddress("");
    });
    return controller.current;
  }
  function owner() {
    if (state?.ownerApprovalVersion !== OWNER_APPROVAL_VERSION)
      throw new Error(
        `Broker/UI approval version mismatch. Restart the broker with npm run setup -- serve, then refresh this page. Expected v${OWNER_APPROVAL_VERSION}; broker reported v${state?.ownerApprovalVersion ?? "unknown"}.`,
      );
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
    setNotice("Agent host access revoked.");
  }
  async function submitGraphMission(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = graphQuestion.trim();
    if (question.length < 8 || graphSubmitting) return;
    setGraphSubmitting(true);
    setError("");
    try {
      owner();
      await api("graph/missions", { question });
      setGraphQuestion("");
      setNotice(
        "Mission queued.",
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
  const connectedOwner = !!address && !!state?.owner &&
    address.toLowerCase() === state.owner.toLowerCase();
  const visibleMissions = connectedOwner
    ? (state?.graphMissions ?? []).filter((mission) =>
        mission.owner?.toLowerCase() === address.toLowerCase())
    : [];
  const activeRoots = active.filter((record) => record.grant.parentId === ROOT);
  const activeDelegated = active.length - activeRoots.length;
  const actionableProposals = (state?.proposals ?? []).filter((proposal) =>
    proposal.expiresAt > now() && (proposal.status === "pending" ||
      proposal.status === "approved" || (proposal.status === "signed" && state?.allowBroadcast)));
  const pastProposals = (state?.proposals ?? []).filter((proposal) =>
    !actionableProposals.includes(proposal));
  function renderApproval(p: Proposal) {
    if (!state) return null;
                    const tx = Transaction.from(p.raw);
                    const reward =
                      p.kind === "graph-agent-reward" && state.paymentAddress
                        ? graphRewardDetails(p.raw, state.paymentAddress)
                        : undefined;
                    return (
                      <article className="panel approval-card" key={p.id}>
                        <div className="team-top">
                          <h3>{reward ? "Graph Agent reward" : "Legacy transaction"}</h3>
                          <span className="badge">
                            {p.expiresAt <= now() && ["pending", "approved", "signed"].includes(p.status) ? "Expired" : p.status}
                          </span>
                        </div>
                        <dl className="approval-summary">
                          <dt>Amount</dt>
                          <dd className="mono tabular-nums">{reward ? GRAPH_REWARD_LABEL : `${tx.value.toString()} wei`}</dd>
                          <dt>Recipient</dt>
                          <dd className="mono">{reward?.recipient ?? tx.to}</dd>
                          <dt>Network</dt>
                          <dd>Base Sepolia</dd>
                        </dl>
                        <details className="approval-details">
                          <summary>Transaction details<ChevronDown size={16} aria-hidden /></summary>
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
                        </details>
                        <div className="team-actions">
                          {p.status === "pending" && p.expiresAt > now() && (
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
                                  ? "Sign & send on Flex"
                                  : "Approve on Flex"}
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
                          {p.status === "approved" && p.expiresAt > now() && (
                            <button
                              disabled={
                                busy || !address || p.expiresAt <= now()
                              }
                              onClick={() => perform(() => sign(p))}
                            >
                              {state.allowBroadcast
                                ? "Sign & send on Flex"
                                : "Sign on Flex"}
                            </button>
                          )}
                          {p.status === "signed" && p.expiresAt > now() && state.allowBroadcast && (
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
                              Resume broadcast
                            </button>
                          )}
                          {p.hash && p.status !== "broadcast" && (
                            <p className="footnote">
                              {p.expiresAt <= now()
                                ? "Expired. This transaction was not broadcast."
                                : "Not broadcast. Resume submission before expiry."}{" "}
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
                              View transaction
                              <ArrowUpRight size={14} aria-hidden />
                            </a>
                          )}
                        </div>
                      </article>
                    );

  }
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="logo" href="/">
          <GitBranch aria-hidden />
          RingTree<span>LAB</span>
        </a>
        <div className="workspace-label">YOUR CONTROL PLANE</div>
        <nav aria-label="Dashboard">
          {["Workspace", "Graph Agent", "Approvals", "Activity"].map((name) => (
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
      </aside>
      <main>
        <header className="topbar">
          <span>{tab !== "Graph Agent" && <>RingTree / <strong>{tab}</strong></>}</span>
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
            {tab === "Activity" && <p className="eyebrow">AUTHORITY, BRANCHING SAFELY</p>}
            <h1>
              {tab === "Workspace"
                ? "Workspace"
                : tab === "Graph Agent"
                  ? "Graph Agent"
                : tab === "Approvals"
                  ? "Approvals"
                  : "A record of every boundary."}
            </h1>
            <p className="subtitle">
              {tab === "Workspace"
                ? "Manage your agents and permissions."
                : tab === "Graph Agent"
                  ? "Ask a question. Explore live blockchain data."
                : tab === "Approvals"
                  ? "Review and approve agent payments."
                  : "Inspect real broker decisions, completed calls, and denied requests."}
            </p>
          </div>
          <div className="connection-status" role="status" aria-live="polite">
            <span className="network">
              <span className={`status-dot ${brokerOnline ? "connected" : "disconnected"}`} aria-hidden />
              Broker {brokerOnline ? "online" : "offline"}
            </span>
            <span className="network">
              <span className={`status-dot ${address ? "connected" : "disconnected"}`} aria-hidden />
              Ledger {address ? "connected" : "disconnected"}
            </span>
          </div>
        </section>
        {(tab !== "Graph Agent" || notice !== "Connect Ledger Flex to authorize your agent team.") && <div className="notice" role="status" aria-live="polite">
          <ShieldCheck size={18} aria-hidden />
          <span>{notice}</span>
        </div>}
        {tab === "Approvals" && <p className="approval-guidance">Verify the amount and recipient on your Ledger before signing.</p>}
        {(error || brokerError) && (
          <div className="error" role="alert">
            {error || brokerError}
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
                    <small>{activeDelegated} delegated grants</small>
                  </div>
                  <div>
                    <span>Waiting for you</span>
                    <strong>{pending.length}</strong>
                    <small>Pending approvals</small>
                  </div>
                  <div>
                    <span>Agent credentials</span>
                    <strong className="metric-text">{state.ringReady ? "Ready" : state.ringConfigured ? "Locked" : "Not configured"}</strong>
                    <small>
                      {!state.ringConfigured
                        ? "OpenAI key setup pending"
                        : state.ringReady
                          ? "Broker unlocked"
                          : "Unlock the broker to continue"}
                    </small>
                  </div>
                </div>
                <div className="columns workspace-columns">
                  <section className="panel">
                    <div className="panel-head">
                      <div>
                        <h2>Agent team</h2>
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
                          Then start the three agent processes or Docker
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
                                  Disable agent host
                                </button>
                              </>
                            )}
                          </div>
                          {Object.entries(m.agents)
                            .filter(([role]) => role !== "risk")
                            .map(([role, subject]) => {
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
                  <aside className="workspace-help" aria-label="Workspace guide">
                    <details className="panel workspace-disclosure">
                      <summary>Security boundaries<ChevronDown size={18} aria-hidden /></summary>
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
                      <p className="footnote">Review every field on Flex. Reject blind-signing or hash-only screens. Transactions require a separate signature.</p>
                    </details>
                    <details className="panel workspace-disclosure">
                      <summary>Live workflow<ChevronDown size={18} aria-hidden /></summary>
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
                    </details>
                  </aside>
                </div>
              </>
            )}
            {tab === "Graph Agent" && (
              <>
                <div className="graph-composer">
                  <section className="panel">
                    <div className="panel-head">
                      <div>
                        <h2>New mission</h2>
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
                        placeholder="Compare Aave and Morpho lending activity over the last 24 hours."
                        maxLength={600}
                        rows={5}
                        aria-describedby="graph-question-help"
                      />
                      <div className="form-help" id="graph-question-help">
                        <span>8–600 characters</span>
                        <span>{graphQuestion.length}/600</span>
                      </div>
                      {!connectedOwner && (
                        <p className="inline-warning">{address
                          ? "Connect the Ledger registered to this workspace."
                          : "Connect your Ledger to start a mission."}</p>
                      )}
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
                          !connectedOwner ||
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

                </div>
                <section className="panel">
                  <div className="panel-head">
                    <h2>Mission history</h2>
                    <span className="badge">{visibleMissions.length} missions</span>
                  </div>
                  {!visibleMissions.length ? (
                    <div className="empty graph-empty">
                      <Database size={32} aria-hidden />
                      <h3>{!address ? "Connect your Ledger" : !connectedOwner ? "Different Ledger connected" : "No missions yet"}</h3>
                      <p>{!connectedOwner ? "Mission history is shown for the connected workspace owner." : "Your missions will appear here."}</p>
                    </div>
                  ) : (
                    <div className="mission-list">
                      {[...visibleMissions].reverse().map((mission) => (
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
                              <details className="mission-diagnostics">
                                <summary>Sources & query details</summary>
                              <div className="tags" aria-label="MCP tools used">
                                {mission.result.mcpCalls?.map((call, index) => (
                                  <span key={call.name + "-" + index}>{call.name}</span>
                                ))}
                              </div>
                              <small>
                                Live source: {mission.result.source}
                                {mission.result.analysisMode
                                  ? ` · ${mission.result.analysisMode === "standardized-defi" ? "standardized DeFi schema verified" : "general live-data mode"}`
                                  : ""}
                              </small>
                              {mission.result.customSubgraph && (
                                <div className="custom-source">
                                  <small>
                                    ledger-agent · block {mission.result.customSubgraph.blockNumber.toLocaleString("en-US")} · {formatCount(mission.result.customSubgraph.indexedTransfers)} transfers · <span className="tabular-nums">{formatStableAtomic(mission.result.customSubgraph.indexedVolume)}</span> cumulative volume
                                    {mission.result.customSubgraph.freshnessSeconds !== undefined
                                      ? ` · ${mission.result.customSubgraph.freshnessSeconds}s freshness`
                                      : ""}
                                  </small>
                                  {mission.result.customSubgraph.latest24Hours ? (
                                    <div className="graph-metrics" aria-label="Deterministic 24-hour USDC activity">
                                      <div>
                                        <span>24h volume</span>
                                        <strong className="mono tabular-nums" aria-label={`${mission.result.customSubgraph.latest24Hours.volumeUsdc} USDC`}>
                                          {formatStableAtomic(mission.result.customSubgraph.latest24Hours.volumeUnits)}
                                        </strong>
                                      </div>
                                      <div>
                                        <span>Transfers</span>
                                        <strong className="mono tabular-nums">
                                          {formatCount(mission.result.customSubgraph.latest24Hours.transferCount)}
                                        </strong>
                                      </div>
                                      <div>
                                        <span>Whale transfers</span>
                                        <strong className="mono tabular-nums">
                                          {formatCount(mission.result.customSubgraph.latest24Hours.whaleTransferCount)}
                                        </strong>
                                      </div>
                                      <div>
                                        <span>Volume change</span>
                                        <strong className="mono tabular-nums">
                                          {formatPercentChange(mission.result.customSubgraph.volumeChangePercent)}
                                        </strong>
                                      </div>
                                    </div>
                                  ) : (
                                    <small className="snapshot-note">
                                      Hourly comparisons activate after the enhanced Subgraph version is deployed.
                                    </small>
                                  )}
                                </div>
                              )}
                              {mission.result.x402 && (
                                <div className="custom-source">
                                  <small>
                                    x402 query: {mission.result.x402.status}
                                    {mission.result.x402.paidAmountUnits
                                      ? ` · ${formatStableAtomic(mission.result.x402.paidAmountUnits)} USDC`
                                      : ""}
                                    {mission.result.x402.reused ? " · reused receipt" : ""}
                                  </small>
                                  {mission.result.x402.subgraphId && (
                                    <small className="snapshot-note mono">
                                      Paid Subgraph: {mission.result.x402.subgraphId}
                                      {mission.result.x402.blockNumber !== undefined
                                        ? ` · block ${mission.result.x402.blockNumber.toLocaleString("en-US")}`
                                        : ""}
                                      {mission.result.x402.freshnessSeconds !== undefined
                                        ? ` · ${mission.result.x402.freshnessSeconds}s freshness`
                                        : ""}
                                    </small>
                                  )}
                                  {mission.result.x402.dailySpentUnits && mission.result.x402.dailyBudgetUnits && (
                                    <small className="snapshot-note mono tabular-nums">
                                      Daily Graph spend: {formatStableAtomic(mission.result.x402.dailySpentUnits)} / {formatStableAtomic(mission.result.x402.dailyBudgetUnits)} USDC
                                    </small>
                                  )}
                                  {mission.result.x402.reason && (
                                    <small className="snapshot-note">{mission.result.x402.reason}</small>
                                  )}
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
                              {mission.result.mcpCalls?.some(
                                (call) => call.identifier || call.query,
                              ) && (
                                <details className="query-evidence">
                                  <summary>View verifiable query evidence</summary>
                                  {mission.result.mcpCalls
                                    .filter((call) => call.identifier || call.query)
                                    .map((call, index) => (
                                      <article key={`${call.name}-evidence-${index}`}>
                                        <strong>{call.name}</strong>
                                        {call.standardizedSchema && (
                                          <span className="evidence-status">
                                            Standardized schema
                                          </span>
                                        )}
                                        {call.max30DayQueryCount && (
                                          <span className="evidence-status tabular-nums">
                                            {formatCount(call.max30DayQueryCount)} queries in 30 days
                                          </span>
                                        )}
                                        {call.identifier && (
                                          <code>{call.identifier}</code>
                                        )}
                                        {call.query && <pre>{call.query}</pre>}
                                        {call.outputHash && (
                                          <small className="mono">
                                            Output evidence {short(call.outputHash)} · {call.outputBytes === undefined ? "--" : formatCount(String(call.outputBytes))} bytes
                                          </small>
                                        )}
                                      </article>
                                    ))}
                                </details>
                              )}
                              </details>
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
              <section className="approvals-page">
                <div className="panel-head">
                  <h2>Awaiting approval <span className="approval-count">{actionableProposals.length}</span></h2>
                  <span className="badge">
                    {state.allowBroadcast
                      ? "Testnet · Sign & send"
                      : "Sign only"}
                  </span>
                </div>
                {state.allowBroadcast && (
                  <p className="broadcast-warning" role="status">
                    Signing sends the transaction to Base Sepolia.
                  </p>
                )}
                {!actionableProposals.length ? (
                  <div className="empty">
                    <ShieldCheck size={32} aria-hidden />
                    <h3>No pending actions</h3>

                  </div>
                ) : (
                  actionableProposals.map(renderApproval)
                )}
                {pastProposals.length > 0 && (
                  <details className="approval-history">
                    <summary>Past actions <span className="approval-count">{pastProposals.length}</span><ChevronDown size={18} aria-hidden /></summary>
                    {[...pastProposals].reverse().map(renderApproval)}
                  </details>
                )}
              </section>
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
        {tab === "Activity" && <footer>
          <span>RingTree MVP · Ledger DMK + wallet-cli ring</span>
          <span>
            Ledger approval stays local; AWS agents receive capabilities, never
            credentials.
          </span>
        </footer>}
      </main>
    </div>
  );
}
