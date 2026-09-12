import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const region = "us-east-1";
const stack = "ringtree-mvp-us";
const dir = resolve(".ringtree/aws");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const pluginDir = join(
  dir,
  "session-manager-plugin",
  "Payload",
  "usr",
  "local",
  "sessionmanagerplugin",
  "bin",
);

function run(binary: string, args: string[], interactive = false) {
  const child = spawnSync(binary, args, {
    encoding: "utf8",
    stdio: interactive ? "inherit" : "pipe",
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: pluginDir + ":" + process.env.PATH,
      AWS_PAGER: "",
    },
  });
  if (child.error) throw child.error;
  if (child.status !== 0)
    throw new Error(
      interactive ? "Command failed" : child.stderr || `${binary} failed`,
    );
  return child.stdout;
}

function aws(args: string[]) {
  return JSON.parse(
    run("aws", [...args, "--region", region, "--output", "json"]),
  );
}

function outputs() {
  const description = aws([
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    stack,
  ]).Stacks[0];
  if (!["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(description.StackStatus))
    throw new Error(`Stack is ${description.StackStatus}`);
  const values = Object.fromEntries(
    description.Outputs.map((item: { OutputKey: string; OutputValue: string }) => [
      item.OutputKey,
      item.OutputValue,
    ]),
  );
  if (
    !/^i-[a-f0-9]+$/.test(values.InstanceId) ||
    !/^[a-z0-9.-]+$/.test(values.ArtifactBucket)
  )
    throw new Error("Invalid deployment outputs");
  return values as { InstanceId: string; ArtifactBucket: string };
}

function command(instance: string, commands: string[]) {
  return aws([
    "ssm",
    "send-command",
    "--instance-ids",
    instance,
    "--document-name",
    "AWS-RunShellScript",
    "--parameters",
    JSON.stringify({ commands, executionTimeout: ["1800"] }),
    "--comment",
    "RingTree local-broker relay deployment",
  ]).Command.CommandId as string;
}

async function main() {
  const [action, value] = process.argv.slice(2);
  const deployment = outputs();

  if (action === "status") {
    console.log({ region, stack, ...deployment });
    console.log(
      aws([
        "ec2",
        "describe-instances",
        "--instance-ids",
        deployment.InstanceId,
        "--query",
        "Reservations[].Instances[].{Id:InstanceId,State:State.Name,Type:InstanceType,Architecture:Architecture}",
      ]),
    );
    return;
  }

  if (action === "result" && value && /^[a-f0-9-]{36}$/.test(value)) {
    const result = aws([
      "ssm",
      "get-command-invocation",
      "--command-id",
      value,
      "--instance-id",
      deployment.InstanceId,
    ]);
    console.log({
      status: result.Status,
      stdout: result.StandardOutputContent,
      stderr: result.StandardErrorContent,
    });
    return;
  }

  if (action === "relay-tunnel") {
    run(
      "aws",
      [
        "ssm",
        "start-session",
        "--region",
        region,
        "--target",
        deployment.InstanceId,
        "--document-name",
        "AWS-StartPortForwardingSession",
        "--parameters",
        JSON.stringify({ portNumber: ["4320"], localPortNumber: ["4320"] }),
      ],
      true,
    );
    return;
  }

  if (action === "shell") {
    run(
      "aws",
      [
        "ssm",
        "start-session",
        "--region",
        region,
        "--target",
        deployment.InstanceId,
      ],
      true,
    );
    return;
  }

  if (action === "deploy-relay") {
    const tokenPath = resolve(".ringtree/relay-token");
    if (!existsSync(tokenPath))
      writeFileSync(tokenPath, randomBytes(32).toString("hex"), {
        mode: 0o600,
        flag: "wx",
      });
    const token = readFileSync(tokenPath, "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(token))
      throw new Error("Invalid relay token file");

    const archive = join(dir, "local-broker-release.tar.gz");
    run("tar", [
      "--exclude=.DS_Store",
      "--exclude=._*",
      "-czf",
      archive,
      "package.json",
      "package-lock.json",
      ".dockerignore",
      "tsconfig.json",
      "server",
      "shared",
      "scripts",
      "deploy",
    ]);
    const digest = createHash("sha256")
      .update(readFileSync(archive))
      .digest("hex");
    const prefix = `releases/local-broker-${digest}`;
    for (const [path, name] of [
      [archive, "release.tar.gz"],
      [tokenPath, "relay-token"],
    ])
      run("aws", [
        "s3",
        "cp",
        path,
        `s3://${deployment.ArtifactBucket}/${prefix}/${name}`,
        "--region",
        region,
        "--only-show-errors",
      ]);

    const compose = "docker compose -f deploy/compose.local-broker.yaml";
    const commandId = command(deployment.InstanceId, [
      "set -eu",
      `aws s3 cp s3://${deployment.ArtifactBucket}/${prefix}/release.tar.gz /opt/ringtree/local-broker-release.tar.gz --region ${region} --only-show-errors`,
      `echo '${digest}  /opt/ringtree/local-broker-release.tar.gz' | sha256sum -c -`,
      "tar -xzf /opt/ringtree/local-broker-release.tar.gz -C /opt/ringtree/app",
      "cd /opt/ringtree/app",
      "docker build --platform linux/arm64 -f deploy/Dockerfile.relay -t ringtree:aws-arm64 .",
      "install -d -o 1000 -g 1000 -m 700 /opt/ringtree/state/relay",
      `aws s3 cp s3://${deployment.ArtifactBucket}/${prefix}/relay-token /opt/ringtree/state/relay/token --region ${region} --only-show-errors`,
      "chown 1000:1000 /opt/ringtree/state/relay/token",
      "chmod 600 /opt/ringtree/state/relay/token",
      `${compose} up -d --remove-orphans`,
      `${compose} ps`,
    ]);
    console.log({
      commandId,
      next: "After Success: npm run aws -- relay-tunnel, then npm run connect:aws",
    });
    return;
  }

  console.log(
    "Commands: status | deploy-relay | result <command-id> | relay-tunnel | shell",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "AWS operation failed");
  process.exitCode = 1;
});
