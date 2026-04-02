# Changelog

All notable changes to the "Company Coding Standard" extension are documented here.

## [0.0.58] - 2026-04-01

### Added
- `/project` command now supports a new **child-page flow**: configure `companyStandards.devToolsPageId` with a Confluence parent page ID and the command lists its subpages via QuickPick, then loads and applies the selected guide with the LLM.
- `confluenceChildPageHandler.ts`: new shared handler with three reusable functions — `pickAndLoadChildPage`, `applyChildPageAsGuide`, `applyChildPageAsStandard`, and `applyChildPageAsPrompt`.
- `ConfluenceClient.getChildPages()`: lightweight Confluence v2 API call that fetches direct child pages (id + title) sorted by title.
- `KnowledgeProvider.getChildPages()`: optional method added to the interface; implemented by `ConfluenceKnowledgeProvider`.

### Improved
- Extension icon updated: `icon.svg` replaces the old `bank-agent.svg` / `company-agent.svg` references in both the participant icon path and `package.json`.
- Code formatting pass on `bankAgent.ts`: trailing commas, consistent indentation, and multi-line call signatures aligned to project ESLint style.

### Fixed
- `NotionKnowledgeProvider.toKnowledgeBlock()`: `content.rich_text` is now correctly cast to `RichTextArray | undefined` before being passed to `rt()`, resolving eight `TS2345` type errors introduced when `tsconfig.json` strict mode propagated `unknown`.

## [0.0.47] - 2026-03-31

### Added
- `/pr-review` command: reviews the full diff of the current branch vs. a base branch selected via QuickPick, analysing logic changes, test coverage, naming, potential bugs, and standards violations.
- `/coverage` command: analyses Maven JaCoCo coverage reports (`target/site/jacoco/jacoco.csv`) or Surefire reports, shows a per-class coverage table, and suggests which classes to test when they fall below the configured threshold.
- `/new-feature` guided flow: select a Jira story, plan the implementation following company standards, and write it back to Jira on completion.

### Improved
- `/jira` redesigned as a guided 3-operation flow: list issues with time metrics, view/create subtasks, and update documentation.
- `/search` now returns a directly synthesised answer built from Confluence results rather than a raw list of links.
- `/checkstyle` iterates until Maven `checkstyle:check` reports zero errors, applying JavaDoc and formatting fixes in a loop.
- `/review`, `/generate-test`, and `/commit` handlers refactored with shared workspace-context utilities to reduce duplication.

### Internal
- Technical debt pass (P1): shared helpers extracted, activation events tightened to `onStartupFinished`.
- Test suite: 69 unit tests across 5 suites, all passing.

## [0.0.46] - prior release

Initial marketplace release covering: `/standards`, `/review`, `/create`, `/prompts`, `/specialty`, `/generate-test`, `/docs`, `/commit`, `/new-feature`, `/jira`, `/project`, `/onboarding`, `/setup`, `/search`, `/explain`, `/document`, `/security`, `/checkstyle`.
