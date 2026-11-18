// Has a register only ever grown? (security loop, "Needs James" item 3.)
//
// A register is a file in a repository, and its founder can write to it. The
// phones and the register page remember what they have seen, so a lock taken
// off later shows to anybody who looked before. Somebody looking for the first
// time cannot tell. The repository's history can: force-pushes to main are
// refused (the "Protect main" rule), so every version the register has ever
// had stays in it, and this checks each version against the one before.
//
// Growing means:
//   - every lock already listed is still listed, in the same place, unchanged,
//     and new ones are only ever added at the end;
//   - every member already listed is still listed, in the same place, with the
//     same number, address, signature and date; the only change allowed is
//     a later version of the declaration added to their `also_signed`.
//
// Pure: it is given the versions, oldest first, and touches nothing else.

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** What changed between two versions of a register that a register may not do, or [] if it only grew. */
export function shrinkage(before, after) {
  const problems = [];
  const bl = Array.isArray(before?.locks) ? before.locks : [];
  const al = Array.isArray(after?.locks) ? after.locks : [];
  bl.forEach((lock, i) => {
    if (!same(lock, al[i])) problems.push(`lock ${i + 1} (${lock?.address ?? "?"}) was ${al[i] ? "changed or moved" : "removed"}`);
  });
  const bm = Array.isArray(before?.members) ? before.members : [];
  const am = Array.isArray(after?.members) ? after.members : [];
  bm.forEach((m, i) => {
    const n = am[i];
    const { also_signed: was = [], ...rest } = m ?? {};
    const { also_signed: now = [], ...restNow } = n ?? {};
    if (!n || !same(rest, restNow)) { problems.push(`member ${m?.n ?? i + 1} (${m?.address ?? "?"}) was ${n ? "changed or moved" : "removed"}`); return; }
    // Later signatures are kept in version order, so an earlier one can move
    // along when a member signs a version in between: each must still be
    // there, unchanged, but not necessarily in the same place (OpenAI review 7).
    if (!Array.isArray(now) || !was.every((e) => now.some((x) => same(x, e)))) problems.push(`member ${m.n}'s later signatures were changed or removed`);
  });
  return problems;
}

/** Every step in a register's history that was not growth: [{ step, problems }]. `versions` oldest first; null entries (unreadable) are reported. */
export function historyProblems(versions) {
  const out = [];
  let last = null;
  versions.forEach((v, step) => {
    if (v === null) { out.push({ step, problems: ["this version is not readable JSON"] }); return; }
    if (last) { const p = shrinkage(last, v); if (p.length) out.push({ step, problems: p }); }
    last = v;
  });
  return out;
}
