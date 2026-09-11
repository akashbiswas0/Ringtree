import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { Wallet, hexlify, randomBytes } from "ethers";
import {
  domain,
  digest,
  ROOT,
  grantTypes,
  grantMessage,
  callTypes,
  callMessage,
  type Grant,
  type Call,
  canonical,
} from "../shared/protocol";
import { read, save } from "./io";
type Role = "orchestrator" | "researcher" | "risk" | "executor";
const roles: Role[] = ["orchestrator", "researcher", "risk", "executor"];
const dir = resolve(process.env.RINGTREE_AGENT_DIR ?? ".ringtree/agents");
const broker = process.env.RINGTREE_BROKER_URL ?? "http://127.0.0.1:4318";
type Identity = { privateKey: string; hostPrivateKey: string };
type Manifest = {
  hostId: string;
  label: string;
  agents: Record<Role, string>;
  proof: string;
};
type State = {
  configured: boolean;
  ringReady: boolean;
  graphReady?: boolean;
  salt: string;
  owner: string;
  grants: Array<{ grant: Grant; revoked: boolean }>;
  results: Array<{
    rootId: string;
    tool: string;
    subject: string;
    result: unknown;
  }>;
  graphMissions?: Array<{
    id: string;
    question: string;
    status: "queued" | "running" | "completed" | "failed";
    rewardProposalId?: string;
  }>;
  proposals?: Array<{
    kind?: "graph-agent-reward";
    status: string;
    expiresAt: number;
  }>;
};
const nonce = () => hexlify(randomBytes(32));
async function api(path: string, body?: unknown) {
  const r = await fetch(broker + "/api/" + path, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(65000),
  });
  const v = await r.json();
  if (!r.ok) throw new Error(v.error ?? "REQUEST_FAILED");
  return v;
}
async function main() {
  const command = process.argv[2];
  if (command === "init") {
    const state = (await api("state")) as State;
    if (!state.configured)
      throw new Error("Configure the owner first with npm run setup.");
    if (existsSync(join(dir, "manifest.json")))
      throw new Error("Agent identities already exist.");
    const host = Wallet.createRandom();
    const agents = Object.fromEntries(
      roles.map((r) => [r, Wallet.createRandom()]),
    );
    for (const role of roles)
      save(join(dir, role, "identity.json"), {
        privateKey: agents[role].privateKey,
        hostPrivateKey: host.privateKey,
      });
    const unsigned = {
      hostId: host.address,
      label: process.env.RINGTREE_TEAM_LABEL ?? "RingTree research team",
      agents: Object.fromEntries(roles.map((r) => [r, agents[r].address])),
    };
    const manifest = {
      ...unsigned,
      proof: await host.signTypedData(
        domain(state.salt),
        { AgentManifest: [{ name: "digest", type: "bytes32" }] },
        { digest: digest(unsigned) },
      ),
    };
    save(join(dir, "manifest.json"), manifest);
    console.log(
      "Created four separate agent identities. Registering their public manifest.",
    );
    await api("manifests", manifest);
    console.log(
      "Open the dashboard to authorize the host and root grant on Flex.",
    );
    return;
  }
  if (command === "register") {
    await api("manifests", read(join(dir, "manifest.json")));
    console.log("Public manifest registered.");
    return;
  }
  if (command === "start") {
    const role = process.argv[3] as Role;
    if (!roles.includes(role))
      throw new Error("Specify orchestrator, researcher, risk, or executor.");
    const roleDir = process.env.RINGTREE_ROLE_DIR ?? join(dir, role);
    const identity = read<Identity>(join(roleDir, "identity.json"));
    const wallet = new Wallet(identity.privateKey),
      host = new Wallet(identity.hostPrivateKey);
    const manifest = read<Manifest>(
      process.env.RINGTREE_MANIFEST ?? join(dir, "manifest.json"),
    );
    mkdirSync(roleDir, { recursive: true, mode: 0o700 });
    const doneFile = join(roleDir, "completed.json");
    const done = new Set(existsSync(doneFile) ? read<string[]>(doneFile) : []);
    let previousError = "";
    async function call(
      g: Grant,
      tool: string,
      input: Record<string, unknown>,
      salt: string,
    ) {
      const c = {
        grantId: g.id,
        tool,
        input,
        nonce: nonce(),
        timestamp: Math.floor(Date.now() / 1000),
      };
      return api("call", {
        ...c,
        signature: await wallet.signTypedData(
          domain(salt),
          callTypes,
          callMessage(c),
        ),
        hostSignature: await host.signTypedData(
          domain(salt),
          callTypes,
          callMessage(c),
        ),
      });
    }
    console.log(`${role}: waiting for a valid Ledger grant.`);
    while (true) {
      try {
        const s = (await api("state")) as State;
        const queuedGraphMission = s.graphMissions?.find(
          (item) => item.status === "queued" && !done.has(item.id),
        );
        const rewardInFlight = s.proposals?.some(
          (proposal) =>
            proposal.kind === "graph-agent-reward" &&
            ["pending", "approved", "signed", "broadcasting"].includes(
              proposal.status,
            ) &&
            proposal.expiresAt > Date.now() / 1000,
        );
        const rewardMission = rewardInFlight
          ? undefined
          : s.graphMissions?.find(
              (item) =>
                item.status === "completed" &&
                !item.rewardProposalId &&
                !done.has("reward:" + item.id),
            );
        const record = [...s.grants]
          .reverse()
          .find(
            (r) =>
              r.grant.subject === wallet.address &&
              !r.revoked &&
              r.grant.expiresAt > Date.now() / 1000 &&
              (role === "researcher"
                ? !done.has(r.grant.id) ||
                  Boolean(
                    queuedGraphMission &&
                      r.grant.tools.includes("graph.answer"),
                  )
                : role === "executor"
                  ? !done.has(r.grant.id) || Boolean(rewardMission)
                  : !done.has(r.grant.id)),
          );
        if (record) {
          const g = record.grant;
          if (role === "orchestrator") {
            for (const child of ["researcher", "executor"] as const) {
              const tools: Grant["tools"] =
                child === "researcher"
                  ? ["graph.answer"]
                  : ["tx.prepare"];
              const exists = s.grants.some(
                (r) =>
                  r.grant.parentId === g.id &&
                  r.grant.subject === manifest.agents[child],
              );
              if (exists) continue;
              const delegated: Grant = {
                ...g,
                id: nonce(),
                parentId: g.id,
                issuer: wallet.address,
                subject: manifest.agents[child],
                tools,
                maxCalls: child === "researcher" ? 8 : 4,
                nonce: nonce(),
              };
              await api("grants", {
                grant: delegated,
                signature: await wallet.signTypedData(
                  domain(s.salt),
                  grantTypes,
                  grantMessage(delegated),
                ),
              });
            }
            // Deliberately hostile, signed requests exercise the real broker, not a UI simulation.
            for (const [tool, input] of [
              ["secret.read", {}],
              ["chain.read", { url: "https://attacker.invalid" }],
            ] as const) {
              try {
                await call(g, tool, input, s.salt);
              } catch (e) {
                console.log("Attack blocked:", (e as Error).message);
              }
            }
            const escalated = {
              ...g,
              id: nonce(),
              parentId: g.id,
              issuer: wallet.address,
              maxCalls: g.maxCalls + 1,
              nonce: nonce(),
            };
            try {
              await api("grants", {
                grant: escalated,
                signature: await wallet.signTypedData(
                  domain(s.salt),
                  grantTypes,
                  grantMessage(escalated),
                ),
              });
            } catch (e) {
              console.log("Escalation blocked:", (e as Error).message);
            }
          } else if (role === "researcher") {
            const mission = g.tools.includes("graph.answer")
              ? queuedGraphMission
              : undefined;
            if (mission) {
              if (!s.graphReady) {
                await new Promise((r) => setTimeout(r, 3000));
                continue;
              }
              await call(
                g,
                "graph.answer",
                { missionId: mission.id, question: mission.question },
                s.salt,
              );
              done.add(mission.id);
              writeFileSync(doneFile, JSON.stringify([...done]), {
                mode: 0o600,
              });
              console.log(`graph agent: completed mission ${mission.id}.`);
              continue;
            }
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          } else if (role === "risk") {
            await new Promise((r) => setTimeout(r, 3000));
            continue;
          } else {
            if (!rewardMission) {
              await new Promise((r) => setTimeout(r, 2000));
              continue;
            }
            const result = await call(
              g,
              "tx.prepare",
              { missionId: rewardMission.id },
              s.salt,
            );
            done.add("reward:" + rewardMission.id);
            console.log(
              "Graph Agent reward queued for Ledger approval:",
              result.proposal.id,
            );
          }
          done.add(g.id);
          writeFileSync(doneFile, JSON.stringify([...done]), { mode: 0o600 });
          console.log(`${role}: completed assigned step.`);
        }
        previousError = "";
      } catch (e) {
        const message = (e as Error).message;
        if (message !== previousError) {
          console.error(`${role}: ${message}`);
          previousError = message;
        }
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  console.log(
    "Commands: init | register | start <orchestrator|researcher|risk|executor>",
  );
}
main().catch((e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
