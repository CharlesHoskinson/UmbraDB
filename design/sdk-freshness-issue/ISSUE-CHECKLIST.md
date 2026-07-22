# Issue-Filing Checklist

A pre-flight checklist for filing a public GitHub issue (bug, hardening note, or
enhancement) against someone else's open-source repository. Run down this list
before you file; run `issue-linter.sh` against the draft as a mechanical
second pass (it catches a subset of these automatically — see the mapping at
the end of each section).

## 1. Title

- [ ] One line, states the problem (or the proposal), not the fix. Bad:
      "Software crashes" / "Please improve sync". Good: "Sync completion is
      measured against the indexer's self-reported tip, with no independent
      finality check."
- [ ] Specific enough to be found by someone searching for the same problem
      later; generic enough not to bury it in implementation detail.
- [ ] No punctuation theatrics — no leading "BUG:", no trailing period, no
      ALL CAPS, no severity self-rating in the title ("CRITICAL:").
  - *Sources:* Mozilla bug-writing guidelines say a summary should be
    roughly 10 words / under 60 characters and "explain the problem, not
    your suggested solution," contrasting "Cancelling a File Copy dialog
    crashes File Manager" (good) with "Software crashes" (bad) —
    <https://bugzilla.mozilla.org/page.cgi?id=bug-writing.html>.

## 2. Scope — one issue per report

- [ ] The report covers exactly one problem or one proposal. Split anything
      that reads as "also, separately, I noticed…" into its own issue.
- [ ] You searched existing issues (open and closed) for the same report
      before filing.
  - *Sources:* "Open a new bug report for each issue!" —
    <https://bugzilla.mozilla.org/page.cgi?id=bug-writing.html>. "Search
    for existing issues... one that matches what you're seeing" is the
    first step in most CONTRIBUTING guides, e.g.
    <https://github.com/necolas/issue-guidelines/blob/master/CONTRIBUTING.md>.
    GitHub's own issue composer surfaces likely duplicates once title +
    ~100 characters of body are filled in —
    <https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-an-issue>.

## 3. Context and versions

- [ ] Names the component/module affected.
- [ ] Names the exact version, tag, or commit hash the observation is
      against (not "latest" — a moving target is not reproducible).
- [ ] Names the relevant environment (API version, platform, config) if the
      behavior is environment-dependent.
  - *Sources:* Mozilla: environment info (build ID, OS, config) is
    required. Simon Tatham: "state the version numbers of the program... and
    of anything else you're using" —
    <https://www.chiark.greenend.org.uk/~sgtatham/bugs.html>.

## 4. Precise location (bug) or precise "where/what" (design/hardening issue)

- [ ] Every non-obvious claim is anchored to a `file:line` reference,
      function/symbol name, or a quoted spec passage with its own location —
      not "somewhere in the sync code."
- [ ] For a reproducible bug: numbered, minimal, independently-runnable
      repro steps; a reduced test case beats a full project export.
- [ ] For a design/hardening note with no single repro: the exact code path
      that produces the property you're describing, traced end to end, so a
      maintainer can verify the claim by reading, not by re-deriving it.
  - *Sources:* "Steps to reproduce are the most important part of any bug
    report" — Mozilla. "The aim of a bug report is to enable the programmer
    to see the program failing in front of them" — Tatham. "Provide a
    reduced test case ... with a live example" —
    <https://github.com/necolas/issue-guidelines/blob/master/CONTRIBUTING.md>.

## 5. Expected vs. actual (or observation, for a design issue)

- [ ] States what should happen (or what the spec/docs claim) and what
      actually happens (or what the code actually does), as two distinguishable
      statements.
- [ ] Separates observed fact from your interpretation of it. Facts first,
      theory clearly labeled as theory.
  - *Sources:* "Try to make very clear what are actual facts... and what
    are speculations... don't leave out facts" — Tatham.

## 6. Impact — scoped honestly

- [ ] States what is *not* affected as clearly as what is (e.g., "keys still
      control funds; no forged spend is accepted" alongside the actual gap).
- [ ] States the realistic trigger conditions (who has to do what, or what
      has to fail, for this to matter) rather than a worst-case-only framing.
- [ ] Matches severity language to what you can actually demonstrate — see
      the hardening-specific rules below before using words like "critical"
      or "vulnerability."

## 7. Prior art

- [ ] At least one external reference point (another project's threat model,
      a spec passage, a related CVE/advisory, prior discussion) that shows
      this isn't a novel or idiosyncratic concern.
- [ ] Quotes or paraphrases with attribution, not bare assertion.

## 8. Suggested fix or direction — without over-prescribing

- [ ] Offers a direction, not a mandated implementation. Frame as "one way
      to close this" rather than "you must implement X."
- [ ] Distinguishes a minimal/interim mitigation from a fuller fix if both
      exist, so maintainers can pick based on their own constraints.
- [ ] Offers to help (PR, discussion) without assuming the offer will be
      taken up.
  - *Sources:* Feature/change requests should "make a strong case... [with]
    context about how the proposal aligns with project scope," not dictate
    the solution — necolas/issue-guidelines.

## 9. Tone

- [ ] Reads as a peer flagging something useful, not a customer filing a
      complaint. No demands, no urgency theater, no "you should have
      caught this."
- [ ] Assumes competence and good faith on the maintainers' side; the code
      is being described, not the people who wrote it.
- [ ] Short. A maintainer should be able to skim it in under a minute and
      know exactly what's being claimed.
  - *Sources:* "There is no point in swearing at the programmer or being
    deliberately unhelpful; the bug will get fixed faster if you help them"
    — Tatham. On what erodes goodwill: demanding urgent fixes, treating
    volunteer maintainers as a support desk, and applying guilt/pressure —
    Mike McQuaid, "Entitlement in Open Source",
    <https://mikemcquaid.com/entitlement-in-open-source/>.

## 10. Dedupe and searchability

- [ ] Title and body use terms a second person hitting the same problem
      would actually search for (symptom language), not only your internal
      names for it.
- [ ] Checked closed issues and merged PRs too — a "fixed" label without a
      released version doesn't mean it shipped.

## 11. Formatting / skimmability

- [ ] Headings for the fixed sections you're using (Impact, Prior art,
      Suggested fix, etc.) rather than one undifferentiated block.
- [ ] Code/paths in backticks; long output in a fenced block or collapsed
      `<details>`, not pasted inline.
- [ ] No walls of text — short paragraphs, bullets where they carry
      information (not decoration).

## 12. No self-referential leakage

- [ ] No internal project names, tool names, process nouns, or team
      references that mean nothing outside your organization (e.g., a
      private codename, "our council," "our design doc," "sprint,"
      "we investigated," "our project"). Rewrite every such reference in
      terms the public repo's own vocabulary would use.
- [ ] No trace of how the write-up was produced (draft/review process,
      internal file paths, internal ticket IDs).

## 13. AI-slop self-check

- [ ] No rhetorical throat-clearing: "it's worth noting," "it's important
      to," "delve," "leverage," "robust," "in today's world," and similar
      filler add no information — cut them.
- [ ] No rhetorical counting ("there are three reasons," "several ways")
      unless the count is load-bearing and each item is substantive.
- [ ] Em dashes used sparingly, not as a tic.
- [ ] No listicle-of-listicles — bolded-header bullets nested inside more
      bolded-header bullets with no prose connecting them.
  - *Sources:* on 2026 AI-writing tells (hedging vocabulary, rule-of-three
    enumeration, bold-header listicle structure, em-dash overuse):
    <https://www.oliviacal.com/post/ai-writing-tells>,
    <https://www.glukhov.org/post/2025/12/ai-slop-detection/>.

---

## Hardening / security-adjacent issues — additional rules

Use this section whenever the report describes a weakness, trust-boundary
gap, or missing defense-in-depth rather than a functional bug. If in doubt
about severity, resolve it *down*, not up — see the stop-condition at the
end.

- [ ] **State the framing explicitly, in the first few lines.** Say plainly
      whether this is a vulnerability report or a hardening suggestion, and
      why it is being filed as a public issue rather than through a private
      channel. If it is a hardening note, say so before a reader has to
      guess from tone.
- [ ] **If it is actually exploitable, STOP.** Do not file it as a public
      issue. Use the repository's `SECURITY.md` / private vulnerability
      reporting flow, or GitHub's draft security advisory. Filing a live
      exploit publicly is itself the harm.
      <https://docs.github.com/en/code-security/security-advisories/about-coordinated-disclosure-of-security-vulnerabilities>
      — "disclosing the vulnerability publicly without giving maintainers a
      chance to remediate" is the failure mode private channels exist to
      prevent.
- [ ] **Name which axis of the threat model is affected**, and which is
      not. ("This is a liveness/view-integrity gap, not a fund-safety one" is
      a scoping sentence, not hedging — keep it.)
- [ ] **Don't reach for severity words you can't back up.** Reserve
      "vulnerability," "exploit," "critical," "CVE," "fund loss" for cases
      you can actually demonstrate as such. A hardening note that inflates
      itself to "critical vulnerability" will be read as either alarmist or
      naive by the people who have to triage it — and burns the credibility
      of your next report.
- [ ] **Ground it in already-accepted threat-model language from the
      project's own docs/spec** wherever you can quote it, so the gap reads
      as "an axis you already agreed matters, that isn't yet covered" rather
      than a new demand.
- [ ] **Cite prior art from comparable systems' threat models** (e.g., how
      another wallet/light-client project treats the same trust boundary) —
      this is what turns "I think this matters" into "this is the standard
      concern here, and here is how it's usually closed."
- [ ] **Offer a proportionate range of fixes**: a cheap interim mitigation
      and a fuller architectural one, and let the maintainers choose based on
      their own resourcing — don't present only the maximal rewrite.
- [ ] **Do not name your own project/organization's internal process** for
      *how* you found this (see §12) — describe the target repo's code, not
      your investigation's internal history.

---

## Mapping to `issue-linter.sh`

The linter mechanically checks a subset of the above. It cannot judge tone,
prior-art quality, or whether a "suggested fix" is actually reasonable — it
flags patterns, not correctness.

| Checklist item | Linter check |
|---|---|
| §1 Title | H1 present as first line |
| §3 Context/version | version/commit-hash pattern present |
| §4 Precise location | `file:line` or URL citation present |
| §6 Impact | "Impact" heading/keyword present |
| §8 Suggested fix | "Suggested"/"Proposed"/"Recommendation" heading present |
| §2 One issue per report | warns if more than one H1 heading found |
| §12 No self-referential leakage | greps for named internal terms |
| §13 AI-slop self-check | hedging-phrase list, rhetorical counting, em-dash count, bold-header-bullet density |
| Hardening §"don't reach for severity words" | greps for vulnerability/exploit/critical/fund-loss/CVE/RCE |

Everything else on this checklist needs a human.

## Sources consulted

- GitHub Docs, "Creating an issue" — <https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-an-issue>
- GitHub Docs, "About coordinated disclosure of security vulnerabilities" — <https://docs.github.com/en/code-security/security-advisories/about-coordinated-disclosure-of-security-vulnerabilities>
- Mozilla, "Bug Writing Guidelines" — <https://bugzilla.mozilla.org/page.cgi?id=bug-writing.html>
- Simon Tatham, "How to Report Bugs Effectively" — <https://www.chiark.greenend.org.uk/~sgtatham/bugs.html>
- necolas, "Guidelines for Contributing Issues" (widely reused CONTRIBUTING template) — <https://github.com/necolas/issue-guidelines/blob/master/CONTRIBUTING.md>
- Mike McQuaid, "Entitlement in Open Source" — <https://mikemcquaid.com/entitlement-in-open-source/>
- Olivia Cal, "How to Spot AI Writing Tells" — <https://www.oliviacal.com/post/ai-writing-tells>
- Rost Glukhov, "Detecting AI Slop: Techniques & Red Flags" — <https://www.glukhov.org/post/2025/12/ai-slop-detection/>
