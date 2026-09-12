import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { ConfigSchema } from "../server/config";
import { JoinRequest, JoinBundle, joinTypes, approvalMessage } from "../shared/enrollment";
import { verifyOwnerApproval } from "../shared/owner-approval";
const region="us-east-1", stack="ringtree-mvp-us";
const dir=resolve(".ringtree/aws");
mkdirSync(dir,{recursive:true,mode:0o700});
const pluginDir=join(dir,"session-manager-plugin","Payload","usr","local","sessionmanagerplugin","bin");
function run(bin:string,args:string[],interactive=false) {
  const p=spawnSync(bin,args,{encoding:"utf8",stdio:interactive?"inherit":"pipe",maxBuffer:16*1024*1024,env:{...process.env,PATH:pluginDir+":"+process.env.PATH,AWS_PAGER:""}});
  if(p.error)throw p.error;
  if(p.status!==0)throw Error(interactive?"Command failed":p.stderr||`${bin} failed`);
  return p.stdout;
}
function aws(args:string[]) {return JSON.parse(run("aws",[...args,"--region",region,"--output","json"]));}
function outputs() {
  const s=aws(["cloudformation","describe-stacks","--stack-name",stack]).Stacks[0];
  if(!["CREATE_COMPLETE","UPDATE_COMPLETE"].includes(s.StackStatus))throw Error(`Stack is ${s.StackStatus}`);
  const o=Object.fromEntries(s.Outputs.map((v:{OutputKey:string;OutputValue:string})=>[v.OutputKey,v.OutputValue]));
  if(!/^i-[a-f0-9]+$/.test(o.InstanceId)||!/^[a-z0-9.-]+$/.test(o.ArtifactBucket))throw Error("Invalid deployment outputs");
  return o as {InstanceId:string;ArtifactBucket:string};
}
function command(instance:string,commands:string[]) {
  return aws(["ssm","send-command","--instance-ids",instance,"--document-name","AWS-RunShellScript","--parameters",JSON.stringify({commands,executionTimeout:["1800"]}),"--comment","RingTree deployment - no plaintext secrets"]).Command.CommandId;
}
const compose="docker compose -f /opt/ringtree/app/deploy/compose.aws.yaml";
async function main() {
  const [action,file]=process.argv.slice(2), o=outputs();
  if(action === "relay-tunnel") {
    run("aws",["ssm","start-session","--region",region,"--target",o.InstanceId,"--document-name","AWS-StartPortForwardingSession","--parameters",JSON.stringify({portNumber:["4320"],localPortNumber:["4320"]})],true);
    return;
  }
  if(action === "deploy-relay") {
    const tokenPath=resolve(".ringtree/relay-token");
    if(!existsSync(tokenPath))writeFileSync(tokenPath,randomBytes(32).toString("hex"),{mode:0o600,flag:"wx"});
    const token=readFileSync(tokenPath,"utf8").trim();
    if(!/^[a-f0-9]{64}$/.test(token))throw Error("Invalid relay token file");
    const archive=join(dir,"local-broker-release.tar.gz");
    run("tar",["--exclude=.DS_Store","--exclude=._*","-czf",archive,"package.json","package-lock.json","Dockerfile",".dockerignore","index.html","tsconfig.json","vite.config.ts","src","server","shared","scripts","deploy"]);
    const digest=createHash("sha256").update(readFileSync(archive)).digest("hex");
    const prefix=`releases/local-broker-${digest}`;
    for(const [path,name] of [[archive,"release.tar.gz"],[tokenPath,"relay-token"]])
      run("aws",["s3","cp",path,`s3://${o.ArtifactBucket}/${prefix}/${name}`,"--region",region,"--only-show-errors"]);
    const id=command(o.InstanceId,[
      "set -eu",
      `aws s3 cp s3://${o.ArtifactBucket}/${prefix}/release.tar.gz /opt/ringtree/local-broker-release.tar.gz --region ${region} --only-show-errors`,
      `echo '${digest}  /opt/ringtree/local-broker-release.tar.gz' | sha256sum -c -`,
      "tar -xzf /opt/ringtree/local-broker-release.tar.gz -C /opt/ringtree/app",
      "cd /opt/ringtree/app",
      "docker build --platform linux/arm64 -t ringtree:aws-arm64 .",
      "install -d -o 1000 -g 1000 -m 700 /opt/ringtree/state/relay",
      `aws s3 cp s3://${o.ArtifactBucket}/${prefix}/relay-token /opt/ringtree/state/relay/token --region ${region} --only-show-errors`,
      "chown 1000:1000 /opt/ringtree/state/relay/token",
      "chmod 600 /opt/ringtree/state/relay/token",
      `${compose} stop`,
      "docker compose -f deploy/compose.local-broker.yaml up -d --remove-orphans",
      "docker compose -f deploy/compose.local-broker.yaml ps",
    ]);
    console.log({commandId:id,next:"After Success: npm run aws -- relay-tunnel, then npm run connect:aws"});
    return;
  }
  if(action==="status") {console.log({region,stack,...o});console.log(aws(["ec2","describe-instances","--instance-ids",o.InstanceId,"--query","Reservations[].Instances[].{Id:InstanceId,State:State.Name,Type:InstanceType,Architecture:Architecture}"]));return;}
  if(action==="upload") {
    const config=ConfigSchema.parse(JSON.parse(readFileSync(".ringtree/broker/config.json","utf8")));
    config.allowBroadcast=false;
    const configPath=join(dir,"public-config.json"), archive=join(dir,"release.tar.gz");
    writeFileSync(configPath,JSON.stringify(config),{mode:0o600});
    // Explicit source allowlist excludes .ringtree, .env and local identities/keychains.
    run("tar",["--exclude=.DS_Store","--exclude=._*","-czf",archive,"package.json","package-lock.json","Dockerfile",".dockerignore","index.html","tsconfig.json","vite.config.ts","src","server","shared","scripts","deploy"]);
    const digest=createHash("sha256").update(readFileSync(archive)).digest("hex"), prefix=`releases/${digest}`;
    for(const [path,name] of [[archive,"release.tar.gz"],[configPath,"config.json"]])run("aws",["s3","cp",path,`s3://${o.ArtifactBucket}/${prefix}/${name}`,"--region",region,"--only-show-errors"]);
    const commands=["set -eu","cloud-init status --wait",`aws s3 cp s3://${o.ArtifactBucket}/${prefix}/release.tar.gz /opt/ringtree/release.tar.gz --region ${region} --only-show-errors`,`echo '${digest}  /opt/ringtree/release.tar.gz' | sha256sum -c -`,"tar -xzf /opt/ringtree/release.tar.gz -C /opt/ringtree/app",`if [ ! -f /opt/ringtree/state/broker/config.json ]; then aws s3 cp s3://${o.ArtifactBucket}/${prefix}/config.json /opt/ringtree/state/broker/config.json --region ${region} --only-show-errors; chown 1000:1000 /opt/ringtree/state/broker/config.json; chmod 600 /opt/ringtree/state/broker/config.json; fi`,"cd /opt/ringtree/app","docker build --platform linux/arm64 -t ringtree:aws-arm64 .",`${compose} up -d broker`,"for n in $(seq 1 30); do curl -fsS http://127.0.0.1:4318/api/state >/dev/null && break; sleep 2; done","if [ ! -f /opt/ringtree/state/agents/manifest.json ]; then docker run --rm --network host -e RINGTREE_AGENT_DIR=/identity -e 'RINGTREE_TEAM_LABEL=RingTree AWS research team' -v /opt/ringtree/state/agents:/identity ringtree:aws-arm64 npm run agent -- init; fi",`${compose} up -d`,`${compose} ps`];
    const id=command(o.InstanceId,commands);
    writeFileSync(join(dir,"deployment.json"),JSON.stringify({...o,region,stack,digest,commandId:id},null,2),{mode:0o600});
    console.log({commandId:id,next:`npm run aws -- result ${id}`});return;
  }
  if(action==="result"&&file&&/^[a-f0-9-]{36}$/.test(file)) {const r=aws(["ssm","get-command-invocation","--command-id",file,"--instance-id",o.InstanceId]);console.log({status:r.Status,stdout:r.StandardOutputContent,stderr:r.StandardErrorContent});return;}
  if(action==="tunnel") {run("aws",["ssm","start-session","--region",region,"--target",o.InstanceId,"--document-name","AWS-StartPortForwardingSession","--parameters",JSON.stringify({portNumber:["4318"],localPortNumber:["4319"]})],true);return;}
  if(action==="shell"||action==="enroll"||action==="complete-join") {
    const args=["ssm","start-session","--region",region,"--target",o.InstanceId];
    const cmd=action==="enroll"?`sudo sh -c 'docker run --rm -it -v /opt/ringtree/state/broker:/data -v /opt/ringtree/state/secrets:/secrets ringtree:aws-arm64 npm run remote:prepare && ${compose} restart broker'`:action==="complete-join"?`sudo sh -c '${compose} exec broker sh deploy/with-keychain.sh npm run ringlink -- join /data/joined.json && ${compose} exec broker sh deploy/with-keychain.sh sh -c \"WALLET_PASS=\\\$(cat /run/ringtree-secrets/ring-password) npm run remote:check\"'`:undefined;
    if(cmd)args.push("--document-name","AWS-StartInteractiveCommand","--parameters",JSON.stringify({command:[cmd]}));
    run("aws",args,true);return;
  }
  if(action==="fetch-request") {
    const id=command(o.InstanceId,["cat /opt/ringtree/state/broker/join-request.json"]);
    for(let n=0;n<20;n++) {
      await new Promise(r=>setTimeout(r,2000));
      let v;try{v=aws(["ssm","get-command-invocation","--command-id",id,"--instance-id",o.InstanceId]);}catch{continue;}
      if(v.Status==="Success") {const request=JoinRequest.parse(JSON.parse(v.StandardOutputContent));const path=join(dir,"join-request.json");writeFileSync(path,JSON.stringify(request,null,2),{mode:0o600});console.log(`Public request saved: ${path}`);return;}
      if(["Failed","TimedOut","Cancelled"].includes(v.Status))throw Error("Request unavailable. Complete remote enrollment preparation first.");
    }
    throw Error("Public request download timed out");
  }
  if(action==="stage-join"&&file) {
    const bundle=JoinBundle.parse(JSON.parse(readFileSync(resolve(file),"utf8")));
    const cfg=ConfigSchema.parse(JSON.parse(readFileSync(".ringtree/broker/config.json","utf8")));
    const req=JoinRequest.parse(JSON.parse(readFileSync(join(dir,"join-request.json"),"utf8")));
    if(bundle.owner!==cfg.owner||bundle.salt!==cfg.salt||bundle.rootId!==cfg.keyRingRootId||bundle.applicationPath!==cfg.keyRingApplicationPath||bundle.request.memberPubkey!==req.memberPubkey||bundle.request.nonce!==req.nonce||bundle.request.expiresAt<=Date.now()/1000||verifyOwnerApproval(cfg.salt,joinTypes,approvalMessage(bundle),bundle.signature)!==cfg.owner)throw Error("Invalid or expired owner approval for this AWS member");
    const publicBundle=join(dir,"joined.json");
    writeFileSync(publicBundle,JSON.stringify(bundle),{mode:0o600});
    const prefix=`releases/enrollment-${bundle.request.nonce.slice(2)}`;
    const files=[[publicBundle,"joined.json"],[resolve(".ringtree/broker/openai.enc"),"openai.enc"]];
    if(existsSync(resolve(".ringtree/broker/graph.enc")))files.push([resolve(".ringtree/broker/graph.enc"),"graph.enc"]);
    if(existsSync(resolve(".ringtree/broker/payment.enc"))&&existsSync(resolve(".ringtree/broker/payment-address.json"))) {
      files.push([resolve(".ringtree/broker/payment.enc"),"payment.enc"]);
      files.push([resolve(".ringtree/broker/payment-address.json"),"payment-address.json"]);
    }
    for(const [path,name] of files)run("aws",["s3","cp",path,`s3://${o.ArtifactBucket}/${prefix}/${name}`,"--region",region,"--only-show-errors"]);
    const remoteFiles=files.map(([,name])=>`/opt/ringtree/state/broker/${name}`);
    const downloads=files.map(([,name])=>`aws s3 cp s3://${o.ArtifactBucket}/${prefix}/${name} /opt/ringtree/state/broker/${name} --region ${region} --only-show-errors`);
    const id=command(o.InstanceId,["set -eu","test ! -f /opt/ringtree/state/broker/joined.json",...downloads,`chown 1000:1000 ${remoteFiles.join(" ")}`,`chmod 600 ${remoteFiles.join(" ")}`]);
    console.log({commandId:id,next:"After success: npm run aws -- complete-join"});return;
  }
  if(action==="sync-graph-secret") {
    const source=resolve(".ringtree/broker/graph.enc");
    if(!existsSync(source))throw Error("Run npm run setup -- graph-secret first");
    const digest=createHash("sha256").update(readFileSync(source)).digest("hex"), key=`releases/graph-${digest}/graph.enc`;
    run("aws",["s3","cp",source,`s3://${o.ArtifactBucket}/${key}`,"--region",region,"--only-show-errors"]);
    const id=command(o.InstanceId,["set -eu","test ! -f /opt/ringtree/state/broker/graph.enc",`aws s3 cp s3://${o.ArtifactBucket}/${key} /opt/ringtree/state/broker/graph.enc --region ${region} --only-show-errors`,"chown 1000:1000 /opt/ringtree/state/broker/graph.enc","chmod 600 /opt/ringtree/state/broker/graph.enc"]);
    console.log({commandId:id,next:`npm run aws -- result ${id}`});return;
  }
  if(action==="sync-payment-wallet") {
    const encrypted=resolve(".ringtree/broker/payment.enc"), address=resolve(".ringtree/broker/payment-address.json");
    if(!existsSync(encrypted)||!existsSync(address))throw Error("Run npm run setup -- payment-wallet first");
    const digest=createHash("sha256").update(readFileSync(encrypted)).digest("hex"), prefix=`releases/payment-${digest}`;
    for(const [path,name] of [[encrypted,"payment.enc"],[address,"payment-address.json"]])run("aws",["s3","cp",path,`s3://${o.ArtifactBucket}/${prefix}/${name}`,"--region",region,"--only-show-errors"]);
    const id=command(o.InstanceId,["set -eu","test ! -f /opt/ringtree/state/broker/payment.enc","test ! -f /opt/ringtree/state/broker/payment-address.json",`aws s3 cp s3://${o.ArtifactBucket}/${prefix}/payment.enc /opt/ringtree/state/broker/payment.enc --region ${region} --only-show-errors`,`aws s3 cp s3://${o.ArtifactBucket}/${prefix}/payment-address.json /opt/ringtree/state/broker/payment-address.json --region ${region} --only-show-errors`,"chown 1000:1000 /opt/ringtree/state/broker/payment.enc /opt/ringtree/state/broker/payment-address.json","chmod 600 /opt/ringtree/state/broker/payment.enc /opt/ringtree/state/broker/payment-address.json",`${compose} restart broker`]);
    console.log({commandId:id,next:`npm run aws -- result ${id}`});return;
  }
  console.log("Commands: status | upload | result <command-id> | tunnel | shell | enroll | fetch-request | stage-join <joined.json> | complete-join | sync-graph-secret | sync-payment-wallet");
}
main().catch(e=>{console.error(e instanceof Error?e.message:"AWS operation failed");process.exitCode=1;});
