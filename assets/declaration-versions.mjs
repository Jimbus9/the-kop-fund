// The website's own help for a declaration with more than one version.
//
// Site-only: the method's code in js/ stays byte for byte the method's, so
// nothing here is copied there. It only reads: the Crowdlock file, the
// texts it lists, and the register. Every text shown is checked against the
// fingerprint the Crowdlock file gives for it before it is shown.

import { versionsOf, currentVersion, declarationHash, canonicalise } from "../js/crowdlock.mjs";
export { loadCrowdlock } from "./shared.mjs";

/** Is there more than the founding version? */
export const hasLaterVersions = (c) => versionsOf(c).length > 1;

/** The version before the current one. */
export function previousVersion(c) {
  const all = versionsOf(c);
  return all.length > 1 ? all[all.length - 2] : null;
}

/** One version's text, refused unless it hashes to the fingerprint the Crowdlock file gives. */
export async function versionText(base, d) {
  const r = await fetch(`${base}${d.file}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`couldn't load version ${d.version} of the declaration`);
  const text = await r.text();
  if (declarationHash(text) !== d.sha256) {
    throw new Error(`version ${d.version} of the declaration doesn't match its published fingerprint`);
  }
  return canonicalise(text);
}

/** The text in paragraphs, as written: blank lines separate them. */
export const paragraphs = (text) => canonicalise(text).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

/** Paragraph-by-paragraph differences: [{ op: "same" | "gone" | "new", text }]. */
export function differences(oldText, newText) {
  const a = paragraphs(oldText), b = paragraphs(newText);
  const L = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ op: "same", text: a[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: "gone", text: a[i++] });
    else out.push({ op: "new", text: b[j++] });
  }
  while (i < a.length) out.push({ op: "gone", text: a[i++] });
  while (j < b.length) out.push({ op: "new", text: b[j++] });
  return out;
}

const make = (tag, text, cls) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
const isHeading = (p) => !p.includes("\n") && p.length < 60 && p === p.toUpperCase() && /[A-Z]/.test(p);
const numbered = /^(\d+)\.\s+([\s\S]*)$/;

/**
 * Draw a declaration's text into `box`, as plain text: headings, paragraphs
 * and numbered principles. Nothing in the text is ever read as HTML.
 * The first line (the title) is left out, because the page already has it.
 */
export function drawText(box, text) {
  box.textContent = "";
  const ps = paragraphs(text);
  if (ps.length && isHeading(ps[0])) ps.shift();
  let list = null;
  for (const p of ps) {
    const m = p.match(numbered);
    if (m) {
      if (!list) { list = make("ol"); box.append(list); }
      list.append(make("li", m[2]));
      continue;
    }
    list = null;
    if (isHeading(p)) box.append(make("h2", p.charAt(0) + p.slice(1).toLowerCase()));
    else box.append(make("p", p));
  }
}

/** Draw only what changed: each paragraph taken out, then put in, in reading order. */
export function drawChanges(box, oldText, newText) {
  box.textContent = "";
  const changes = differences(oldText, newText).filter((d) => d.op !== "same");
  if (!changes.length) { box.append(make("p", "The words are the same; only the version number changed.")); return; }
  for (const d of changes) {
    const row = make("div", undefined, `change ${d.op}`);
    row.append(make("b", d.op === "gone" ? "Taken out" : "Added"));
    row.append(make("p", d.text));
    box.append(row);
  }
}

/** "15 November 2026" from "2026-11-15". */
export function longDate(iso) {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

export { currentVersion, versionsOf };
