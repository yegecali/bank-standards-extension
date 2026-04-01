# Changelog

All notable changes to the "Company Coding Standard" extension are documented here.

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
