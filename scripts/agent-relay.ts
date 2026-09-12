import { createRelay } from "../server/agent-relay";
import { readFileSync } from "node:fs";
const { agents, connector } = createRelay(readFileSync("/run/relay/token", "utf8").trim());
agents.listen(4318, "0.0.0.0");
connector.listen(4320, "0.0.0.0");
console.log("Agent relay ready; connector port must be published to host loopback only.");
