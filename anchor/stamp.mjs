// Anchor a file to the Bitcoin blockchain.
//
//   node anchor/stamp.mjs                      the declaration
//   node anchor/stamp.mjs ../registrations.json   or any other file
//
// WHAT THIS DOES, AND WHAT IT DOES NOT. It puts the file's fingerprint into
// the blockchain, so the block's timestamp proves a file with exactly these
// bytes existed before that moment. Nobody can later produce a different
// "original" with an earlier date, because they would need a fingerprint in
// an earlier block, and they cannot go back and put one there.
//
// It is NOT a backup. If the declaration vanished tomorrow, this would not
// bring it back — somebody still has to be holding a copy. What it changes is
// that whoever holds one can PROVE it is the original, to anyone, forever.
// That is the difference between "detectable if somebody kept a copy" and
// "provable by anybody".
//
// It costs nothing and spends none of your bitcoin. Public calendar servers
// collect fingerprints from everybody, combine thousands of them into one,
// and put that single value into one Bitcoin transaction — paying the fee
// themselves. The proof this writes shows mathematically that your fingerprint
// is inside that batch, and it keeps working even if the calendars disappear
// afterwards.
//
// The proof is not complete the moment this finishes. The calendars need a
// few hours to get their transaction into a block. Run verify.mjs tomorrow to
// finish it off. Both files belong in the repository.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import OTS from "javascript-opentimestamps";

// A dropped connection to a calendar server arrives as an error on a socket,
// outside any promise this code is awaiting, and would otherwise end the run
// with a Node stack trace. Nobody should have to read one of those to find
// out their internet wobbled.
const networkDied = (e) => {
  console.log();
  console.log("-".repeat(74));
  console.log("The connection to the calendar servers dropped.");
  console.log("-".repeat(74));
  console.log();
  console.log(`  (${e?.code ?? e?.message ?? e})`);
  console.log();
  console.log("Nothing has been written and nothing is lost. This is usually a");
  console.log("passing network problem — wait a minute and run it again.");
  console.log();
  process.exit(1);
};
process.on("uncaughtException", networkDied);
process.on("unhandledRejection", networkDied);

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(process.argv[2] ?? join(here, "..", "..", "spec", "declaration-v1.txt"));
const proofPath = `${target}.ots`;

const line = (s = "") => console.log(s);
const rule = () => line("-".repeat(74));

line();
rule();
line("ANCHORING A FILE TO THE BITCOIN BLOCKCHAIN");
rule();
line();

if (!existsSync(target)) {
  line(`There is no file at ${target}`);
  process.exit(1);
}

// Refuse to overwrite. An existing proof may be hours or years of waiting
// already done, and a fresh stamp would throw that away and start again from
// today — quietly losing the earlier date, which is the whole point of it.
if (existsSync(proofPath)) {
  line(`A proof already exists: ${proofPath}`);
  line();
  line("Not overwriting it. An existing proof carries an earlier date, and");
  line("stamping again would replace that with today's. If you are sure you");
  line("want a second one, move the old file out of the way first.");
  line();
  line("To check or finish the existing proof:  node anchor/verify.mjs");
  line();
  process.exit(1);
}

const bytes = readFileSync(target);
const digest = createHash("sha256").update(bytes).digest("hex");

line(`File         ${target}`);
line(`Size         ${bytes.length} bytes`);
line(`Fingerprint  ${digest}`);
line();
line("This is the fingerprint going into the blockchain. If this file is the");
line("declaration, that string should match the one inside every member's");
line("signature — including yours.");
line();
line("Asking the public calendar servers to timestamp it…");
line();

const detached = OTS.DetachedTimestampFile.fromBytes(new OTS.Ops.OpSHA256(), bytes);

try {
  await OTS.stamp(detached);
} catch (e) {
  line(`That did not work: ${e.message}`);
  line();
  line("The calendars need a working internet connection, and at least two of");
  line("them have to answer. Nothing has been written and nothing is lost —");
  line("try again in a few minutes.");
  line();
  process.exit(1);
}

// Read the proof back before writing it, and check it commits to this file.
//
// Found the hard way: a calendar connection dropped after stamp() had
// returned, and an 84-byte stump of a proof reached the disk — unreadable by
// any OpenTimestamps tool, and sitting there looking exactly like a real
// proof. A truncated proof is worse than no proof, because it is only
// discovered on the day somebody needs it. So the bytes are checked here,
// while there is still somebody watching.
const serialised = Buffer.from(detached.serializeToBytes());
try {
  const readBack = OTS.DetachedTimestampFile.deserialize(serialised);
  const commitsTo = Buffer.from(readBack.fileDigest()).toString("hex");
  if (commitsTo !== digest) throw new Error(`it commits to ${commitsTo}, not this file`);
  if (serialised.length < 100) throw new Error(`only ${serialised.length} bytes — too short to be a real proof`);
} catch (e) {
  line(`The calendars answered, but the proof they produced is not sound: ${e.message}`);
  line();
  line("Nothing has been written. This usually means a connection dropped");
  line("part way through. Try again in a minute.");
  line();
  process.exit(1);
}

writeFileSync(proofPath, serialised);

rule();
line(`Proof written to ${proofPath}  (${serialised.length} bytes)`);
rule();
line();
line("WHAT HAPPENS NOW");
line();
line("The proof is real but not yet finished. The calendars have your");
line("fingerprint and will put it into a Bitcoin transaction within a few");
line("hours. Until that transaction is in a block, the proof points at the");
line("calendars rather than at the chain.");
line();
line("Tomorrow, run:");
line();
line("    node anchor/verify.mjs");
line();
line("which collects the finished proof and tells you which block it landed");
line("in. After that it stands on its own and needs nobody.");
line();
line("Commit both the file and its .ots to the repository.");
line();
