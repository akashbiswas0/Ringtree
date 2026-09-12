import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
const compose=parse(readFileSync("deploy/compose.aws.yaml","utf8"), {merge:true});
it("isolates AWS agents from broker credentials and external networks",()=>{
  expect(compose.networks.agents.internal).toBe(true);
  for(const role of ["orchestrator","researcher","risk","executor"]) {
    const service=compose.services[role];
    expect(service.networks).toEqual(["agents"]);
    expect(service.read_only).toBe(true);
    expect(service.tmpfs).toEqual(["/tmp:rw,noexec,nosuid,size=64m,mode=1777"]);
    expect(service.cap_drop).toEqual(["ALL"]);
    expect(service.security_opt).toContain("no-new-privileges:true");
    expect(service.volumes).toHaveLength(2);
    expect(service.volumes[0]).toContain(`/agents/${role}:/identity`);
    expect(JSON.stringify(service)).not.toMatch(/ring-password|docker.sock|\/state\/broker|AWS_ACCESS_KEY/);
  }
  expect(compose.services.broker.ports).toEqual(["127.0.0.1:4318:4318"]);
});
it("keeps the infrastructure ARM64, encrypted, and without inbound rules",()=>{
  const template=readFileSync("deploy/aws.yaml","utf8");
  expect(template).toContain("InstanceType: m7g.large");
  expect(template).toContain("arm64/hvm/ebs-gp3");
  expect(template).toContain("Encrypted: true");
  expect(template).toContain("SecurityGroupIngress: []");
  expect(template).toContain("HttpTokens: required");
  expect(template).not.toMatch(/WALLET_PASS|OPENAI_API_KEY/);
});
