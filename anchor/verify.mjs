// Check an anchor, and finish it once the calendars have put it in a block.
//
//   node anchor/verify.mjs                     the declaration
//   node anchor/verify.mjs ../registrations.json
//
// Two separate questions, and the first is answerable with no internet at all:
//
//   1. Does this proof belong to this file?  Pure arithmetic — the proof
//      carries the fingerprint it was made for, and either that matches the
//      file sitting here or the proof is for something else.
//
//   2. Is it in the blockchain yet?  This needs to look at Bitcoin. A fresh
//      proof points at the calendar servers; a finished one points at a block.
//      If it is still waiting, this asks the calendars whether they are ready
//      and writes the completed proof back. (OpenTimestamps calls this step
//      "upgrading", which sounds like installing a newer version of
//      something. It is not. It is collecting the missing half of a proof.
//      That word is kept out of what this prints.)
//
// A proof that fails the first question is worthless and should be deleted.
// A proof that passes the first and not the second is simply young.

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
line("CHECKING AN ANCHOR");
rule();
line();

for (const [what, path] of [["file", target], ["proof", proofPath]]) {
  if (!existsSync(path)) {
    line(`There is no ${what} at ${path}`);
    if (what === "proof") line("\nRun  node anchor/stamp.mjs  first.\n");
    process.exit(1);
  }
}

const bytes = readFileSync(target);
const digest = createHash("sha256").update(bytes).digest("hex");
const proofBytes = readFileSync(proofPath);

line(`File         ${target}`);
line(`Fingerprint  ${digest}`);
line();

// --- 1. Does the proof belong to this file? Offline. ------------------------

const detached = OTS.DetachedTimestampFile.deserialize(proofBytes);
const claimed = Buffer.from(detached.fileDigest()).toString("hex");

if (claimed !== digest) {
  rule();
  line("THIS PROOF IS FOR A DIFFERENT FILE.");
  rule();
  line();
  line(`The proof was made for  ${claimed}`);
  line(`but this file is        ${digest}`);
  line();
  line("Either the file has been changed since it was stamped, or the proof");
  line("belongs to something else. A proof that does not match its file proves");
  line("nothing at all. Do not publish it as though it did.");
  line();
  process.exit(1);
}

line("The proof is for this exact file. That part needed no internet and no");
line("trust — the fingerprint is in the proof and it matches.");
line();

// --- 2. Is it in the blockchain yet? Needs the network. ---------------------

const describe = OTS.info(detached);
// A finished proof keeps the calendars' "pending" branches beside the ones
// that reach a block, so the test is whether any branch reaches a block.
const inABlock = /BitcoinBlockHeaderAttestation/.test(describe);

if (inABlock) {
  rule();
  line("FINISHED. This anchor stands on its own.");
  rule();
  line();
  line(describe.trim().split("\n").map((l) => "  " + l).join("\n"));
  line();
  line("Anybody can check this for themselves, now or in twenty years, with");
  line("nothing but this file, this proof and a view of the blockchain.");
  line();
  process.exit(0);
}

line("Not in a block yet — the proof still points at the calendar servers.");
line("Asking them whether they are ready…");
line();

try {
  const collected = await OTS.upgrade(detached);
  if (collected) {
    writeFileSync(proofPath, Buffer.from(detached.serializeToBytes()));
    rule();
    line("COMPLETE. The proof now points at the blockchain itself.");
    rule();
    line();
    line(OTS.info(detached).trim().split("\n").map((l) => "  " + l).join("\n"));
    line();
    line(`Updated ${proofPath} — commit it.`);
    line();
  } else {
    line("The calendars have not got it into a block yet. This is normal for");
    line("the first few hours. Nothing is wrong and nothing is lost: the proof");
    line("on disk is still valid, just not yet finished. Try again tomorrow.");
    line();
  }
} catch (e) {
  line(`Could not reach the calendars: ${e.message}`);
  line();
  line("The proof on disk is untouched. Try again when you have a connection.");
  line();
}
