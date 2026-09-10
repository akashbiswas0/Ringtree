import { describe, it, expect } from "vitest";
import request from "supertest";
import { Wallet, Transaction, hexlify, randomBytes } from "ethers";
import { createApp } from "../server/app";
import { Store } from "../server/store";
import { ownerApprovalText } from "../shared/owner-approval";
import {
  ROOT,
  domain,
  hostTypes,
  grantTypes,
  grantMessage,
  callTypes,
  callMessage,
  decisionTypes,
  type Grant,
} from "../shared/protocol";
const id = () => hexlify(randomBytes(32));
async function fixture(allowBroadcast = false) {
  const owner = Wallet.createRandom(),
    agent = Wallet.createRandom(),
    host = Wallet.createRandom(),
    salt = id();
  const store = new Store(":memory:");
  const raw = Transaction.from({
    type: 2,
    chainId: 84532,
    to: owner.address,
    value: 0n,
    data: "0x",
    nonce: 0,
    gasLimit: 21000n,
    maxFeePerGas: 1000000n,
    maxPriorityFeePerGas: 1000n,
  }).unsignedSerialized;
  let calls = 0;
  const app = createApp(
    store,
    {
      owner: owner.address,
      salt,
      model: "test-fixture",
      allowBroadcast,
      ringBackend: "cli",
    },
    {
      prepare: async () => raw,
      execute: async () => {
        calls++;
        return { source: "test fixture" };
      },
      graphStatus: () => ({ configured: true, ready: true }),
      paymentStatus: () => ({
        configured: true,
        ready: true,
        address: Wallet.createRandom().address,
      }),
    },
    {
      ready: () => false,
      unlocked: () => false,
      withSecret: async () => {
        throw Error("must not be reached");
      },
    },
    async (signedRaw) => Transaction.from(signedRaw).hash!,
  );
  const post = (path: string, body: object) =>
    request(app)
      .post("/api/" + path)
      .set("Host", "localhost:4318")
      .send(body);
  const enrollment = {
    hostId: host.address,
    label: "fixture",
    nonce: id(),
    expiresAt: Math.floor(Date.now() / 1000) + 1000,
    action: "enroll",
  };
  expect(
    (
      await post("hosts", {
        host: enrollment,
        signature: await owner.signMessage(ownerApprovalText(
          domain(salt),
          hostTypes,
          enrollment,
        )),
      })
    ).status,
  ).toBe(200);
  const grant: Grant = {
    id: id(),
    parentId: ROOT,
    issuer: owner.address,
    subject: agent.address,
    hostId: host.address,
    tools: ["chain.read", "tx.prepare", "graph.answer"],
    resource: "base-sepolia",
    maxCalls: 10,
    expiresAt: Math.floor(Date.now() / 1000) + 1000,
    nonce: id(),
  };
  expect(
    (
      await post("grants", {
        grant,
        signature: await owner.signMessage(ownerApprovalText(
          domain(salt),
          grantTypes,
          grantMessage(grant),
        )),
      })
    ).status,
  ).toBe(200);
  async function call(tool: string, input: Record<string, unknown> = {}) {
    const c = {
      grantId: grant.id,
      tool,
      input,
      nonce: id(),
      timestamp: Math.floor(Date.now() / 1000),
    };
    return {
      ...c,
      signature: await agent.signTypedData(
        domain(salt),
        callTypes,
        callMessage(c),
      ),
      hostSignature: await host.signTypedData(
        domain(salt),
        callTypes,
        callMessage(c),
      ),
    };
  }
  return {
    owner,
    agent,
    salt,
    store,
    raw,
    app,
    post,
    call,
    grant,
    calls: () => calls,
  };
}
describe("HTTP enforcement and high-risk transaction lifecycle", () => {
  it("queues a natural-language Graph mission and completes it through a signed capability call", async () => {
    const f = await fixture();
    const queued = await f.post("graph/missions", {
      question: "Compare live Uniswap activity.",
    });
    expect(queued.status).toBe(200);
    expect(queued.body.mission.status).toBe("queued");
    const call = await f.call("graph.answer", {
      missionId: queued.body.mission.id,
      question: queued.body.mission.question,
    });
    expect((await f.post("call", call)).status).toBe(200);
    const state = await request(f.app)
      .get("/api/state")
      .set("Host", "localhost:4318");
    expect(state.body.graphMissions[0].status).toBe("completed");
    expect(state.body.graphMissions[0].result).toEqual({
      source: "test fixture",
    });
    const rewardCall = await f.call("tx.prepare", {
      missionId: queued.body.mission.id,
    });
    const reward = await f.post("call", rewardCall);
    expect(reward.status).toBe(200);
    expect(reward.body.proposal.kind).toBe("graph-agent-reward");
    expect(reward.body.proposal.missionId).toBe(queued.body.mission.id);
    const duplicate = await f.post(
      "call",
      await f.call("tx.prepare", { missionId: queued.body.mission.id }),
    );
    expect(duplicate.body.error).toBe("MISSION_REWARD_EXISTS");
    const secondMission = await f.post("graph/missions", {
      question: "Compare another live USDC activity window.",
    });
    await f.post(
      "call",
      await f.call("graph.answer", {
        missionId: secondMission.body.mission.id,
        question: secondMission.body.mission.question,
      }),
    );
    const secondReward = await f.post(
      "call",
      await f.call("tx.prepare", {
        missionId: secondMission.body.mission.id,
      }),
    );
    expect(secondReward.body.error).toBe("REWARD_ALREADY_PENDING");
  });
  it("distinguishes an encrypted credential from an unlocked broker", async () => {
    const f = await fixture();
    const response = await request(f.app)
      .get("/api/state")
      .set("Host", "localhost:4318");
    expect(response.status).toBe(200);
    expect(response.body.ringConfigured).toBe(false);
    expect(response.body.ringReady).toBe(false);
  });
  it("denies secret reads, arbitrary endpoints, and unknown fields before calling provider", async () => {
    const f = await fixture();
    expect((await f.post("call", await f.call("secret.read"))).body.error).toBe(
      "TOOL_DENIED",
    );
    expect(
      (
        await f.post(
          "call",
          await f.call("chain.read", { url: "https://attacker.invalid" }),
        )
      ).body.error,
    ).toBe("INVALID_INPUT");
    expect(f.calls()).toBe(0);
  });
  it("allows one concurrent request and rejects its replay", async () => {
    const f = await fixture();
    const c = await f.call("chain.read");
    const replies = await Promise.all([f.post("call", c), f.post("call", c)]);
    expect(replies.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(f.calls()).toBe(1);
  });
  it("queues, approves, validates Ledger-owner transaction and rejects replay", async () => {
    const f = await fixture();
    const proposal = (await f.post("call", await f.call("tx.prepare"))).body
      .proposal;
    expect(proposal.status).toBe("pending");
    const signed = await f.owner.signTransaction(Transaction.from(f.raw));
    expect(
      (await f.post("signed", { requestId: proposal.id, raw: signed })).body
        .error,
    ).toBe("PROPOSAL_NOT_APPROVED");
    const decision = {
      requestId: proposal.id,
      digest: proposal.digest,
      decision: "approve",
      nonce: id(),
      expiresAt: Math.floor(Date.now() / 1000) + 200,
    };
    const signature = await f.owner.signMessage(ownerApprovalText(
      domain(f.salt),
      decisionTypes,
      decision,
    ));
    expect((await f.post("decision", { decision, signature })).status).toBe(
      200,
    );
    const altered = Transaction.from(f.raw);
    altered.value = 1n;
    const alteredRaw = await f.owner.signTransaction(altered);
    expect(
      (await f.post("signed", { requestId: proposal.id, raw: alteredRaw })).body
        .error,
    ).toBe("TRANSACTION_MISMATCH");
    expect(
      (await f.post("signed", { requestId: proposal.id, raw: signed })).status,
    ).toBe(200);
    expect(
      (await f.post("signed", { requestId: proposal.id, raw: signed })).body
        .error,
    ).toBe("PROPOSAL_NOT_APPROVED");
    expect(
      (await f.post("broadcast", { requestId: proposal.id })).body.error,
    ).toBe("BROADCAST_DISABLED");
  });
  it("rejects forged human approval", async () => {
    const f = await fixture();
    const proposal = (await f.post("call", await f.call("tx.prepare"))).body
      .proposal;
    const decision = {
      requestId: proposal.id,
      digest: proposal.digest,
      decision: "approve",
      nonce: id(),
      expiresAt: Math.floor(Date.now() / 1000) + 100,
    };
    const signature = await f.agent.signMessage(ownerApprovalText(
      domain(f.salt),
      decisionTypes,
      decision,
    ));
    expect((await f.post("decision", { decision, signature })).body.error).toBe(
      "OWNER_SIGNATURE_REQUIRED",
    );
  });
  it("verifies, signs and broadcasts through one submit request", async () => {
    const f = await fixture(true);
    const proposal = (await f.post("call", await f.call("tx.prepare"))).body
      .proposal;
    const signed = await f.owner.signTransaction(Transaction.from(f.raw));
    const response = await f.post("submit", {
      requestId: proposal.id,
      raw: signed,
    });
    expect(response.status).toBe(200);
    expect(response.body.hash).toBe(Transaction.from(signed).hash);
    expect(f.store.get<{ status: string }>("proposal", proposal.id)?.status).toBe(
      "broadcast",
    );
    expect(
      f.store.events().some(
        (event) => event.type === "ACTION_APPROVED_BY_TRANSACTION_SIGNATURE",
      ),
    ).toBe(true);
    expect(
      (await f.post("submit", { requestId: proposal.id, raw: signed })).body
        .error,
    ).toBe("PROPOSAL_NOT_APPROVABLE");
  });
  it("rejects DNS rebinding and foreign browser origins", async () => {
    const f = await fixture();
    expect(
      (await request(f.app).get("/api/state").set("Host", "attacker.invalid"))
        .status,
    ).toBe(403);
    expect(
      (
        await request(f.app)
          .get("/api/state")
          .set("Host", "localhost")
          .set("Origin", "https://attacker.invalid")
      ).status,
    ).toBe(403);
  });
  it("does not expose signed raw payloads in state", async () => {
    const f = await fixture();
    f.store.put("proposal", id(), { id: id(), signedRaw: "secret-payload" });
    const res = await request(f.app).get("/api/state").set("Host", "localhost");
    expect(JSON.stringify(res.body)).not.toContain("secret-payload");
    expect(res.headers["cache-control"]).toContain("no-store");
  });
});
