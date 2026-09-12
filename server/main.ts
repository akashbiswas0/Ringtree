import express from "express";
import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { Store } from "./store";
import { loadConfig, dataDir } from "./config";
import { RingSecret, graphSecret, paymentSecret } from "./secrets";
import { LiveTools } from "./tools";
import { GraphAgent } from "./graph-agent";
import { X402GraphPayments } from "./x402";
import { createApp } from "./app";
const config = loadConfig();
const store = new Store(join(dataDir, "ringtree.sqlite"));
const secret = new RingSecret(dataDir);
const graphCredential = graphSecret(dataDir);
const paymentCredential = paymentSecret(dataDir);
const paymentAddressPath = join(dataDir, "payment-address.json");
const paymentAddress = existsSync(paymentAddressPath)
  ? (JSON.parse(readFileSync(paymentAddressPath, "utf8")) as { address: string })
      .address
  : undefined;
const x402 = new X402GraphPayments(paymentCredential, paymentAddress);
const graphAgent = new GraphAgent(
  secret,
  graphCredential,
  config?.model ?? "gpt-5.6-terra",
  fetch,
  x402,
);
const tools = new LiveTools(
  secret,
  config?.owner ?? "0x0000000000000000000000000000000000000000",
  config?.model ?? "gpt-5.6-terra",
  graphAgent,
  paymentAddress,
  paymentCredential,
);
const app = createApp(store, config, tools, secret);
if (existsSync("dist")) app.use(express.static(resolve("dist")));
app.listen(4318, process.env.RINGTREE_LISTEN ?? "127.0.0.1", () =>
  console.log(
    "RingTree broker: http://localhost:4318" +
      (config ? "" : " — run npm run setup"),
  ),
);
