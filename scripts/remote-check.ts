import { RingSecret, graphSecret, paymentSecret } from "../server/secrets";
import { checkRing } from "../server/wallet-cli";

async function main() {
  if (process.env.RINGTREE_DATA_DIR !== "/data")
    throw new Error("Run this verification only inside the remote broker.");
  if (!process.env.WALLET_PASS)
    throw new Error("Remote Key Ring password is unavailable.");

  await checkRing(process.env.WALLET_PASS);
  const secret = new RingSecret("/data");
  await secret.withSecret(async () => true);
  const graph = graphSecret("/data");
  if (graph.ready()) await graph.withSecret(async () => true);
  const payment = paymentSecret("/data");
  if (payment.ready()) await payment.withSecret(async () => true);
  console.log(
    "PASS: official wallet-cli ring round-trip succeeded and configured encrypted credentials have valid formats. No plaintext was printed.",
  );
}

main().catch(() => {
  console.error(
    "Remote Key Ring verification failed. Check membership, password, keychain and ciphertext; no plaintext was printed.",
  );
  process.exitCode = 1;
});
