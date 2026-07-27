# Story Pipeline Case Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing one-chapter real production run reach final delivery while keeping domain-content quality inside each Forge Case.

**Architecture:** The external orchestrator transports the current chapter’s mechanically bounded reference slice and upstream artifacts. Each Case template owns generation, review, targeted repair, and approval for its artifact; the orchestrator retains fail-closed interface checks as defense-in-depth and dependency evidence.

**Tech Stack:** TypeScript, Vitest, Forge Scenario YAML/Markdown prompts, SQLite-backed real Pi Case runs.

## Global Constraints

- Do not add Zhihu-specific branches to Forge platform packages.
- Do not let the external orchestrator generate content repair instructions.
- Keep all historical attempts append-only.
- A downstream Case starts only after its parent Case is approved and its interface checks pass.
- No output may reuse 12 consecutive Chinese characters from the reference text.

---

### Task 1: Repair the chapter-draft Case contract

**Files:**
- Modify: `orchestrators/story-pipeline/src/index.ts`
- Modify: `scenarios/zhihu-chapter-draft/scenario.yaml`
- Modify: `scenarios/zhihu-chapter-draft/prompts/chapter-writer.md`
- Modify: `scenarios/zhihu-chapter-draft/prompts/chapter-auditor.md`

**Interfaces:**
- Consumes: `reference_chapter_text`, `chapter_packet`, and Forge revision scope.
- Produces: an approved `chapter_draft` with Chinese quotation marks, no unauthorized direct dialogue or quantified claims, and zero 12-character source overlap.

- [ ] Use the existing failed real Attempt `draft-b001-a1` as the red integration fixture.
- [ ] Pass the current chapter reference slice into the draft Case input.
- [ ] Add writer preflight rules matching the existing deterministic draft checks.
- [ ] Add auditor blocking checks and line-scoped repair instructions for the same rules.
- [ ] Validate the Scenario and rerun the same production configuration.

### Task 2: Continue through ledger and final Cases

**Files:**
- Modify only the first downstream Scenario that fails.
- Preserve: `orchestrators/story-pipeline/src/index.ts` orchestration responsibilities.

**Interfaces:**
- Consumes: the next real validation report and its Forge Case history.
- Produces: a corrected Case template whose own review accepts a mechanically valid artifact.

- [ ] Resume the same run after the draft passes.
- [ ] If ledger fails, capture its exact validation report before editing its template.
- [ ] Apply one root-cause template fix and rerun from the ledger stage.
- [ ] If final fails, capture its exact validation report before editing its template.
- [ ] Apply one root-cause template fix and rerun from the final stage.

### Task 3: Verify complete production delivery

**Files:**
- Verify: `data/story-runs/gaokao-zero-real-003/manifest.json`
- Verify: `data/story-runs/gaokao-zero-real-003/artifacts/final-v1.md`

**Interfaces:**
- Consumes: all Case and validation evidence from the real run.
- Produces: a final manifest with a non-null final artifact path and all active stages delivered.

- [ ] Run `npm test`.
- [ ] Run `npm run check`.
- [ ] Validate every changed Scenario with `forge template validate`.
- [ ] Confirm every active validation report is valid.
- [ ] Confirm the final Case is approved and the manifest points to the delivered final artifact.
