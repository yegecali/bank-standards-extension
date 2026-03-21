import * as vscode from "vscode";
import { NamingRule } from "../notion/parser";
import { matchesConvention, suggestFix } from "./rules";

export interface Violation {
  name: string;
  range: vscode.Range;
  rule: NamingRule;
  suggestion: string;
}

/**
 * Patterns to extract named identifiers from TypeScript/JavaScript source.
 * Each entry has:
 *   - regex: captures the identifier in group 1
 *   - contextHints: keywords that identify what kind of identifier it is
 *                   (matched against NamingRule.context)
 */
interface ExtractorPattern {
  source: string;
  flags: string;
  contextHints: string[];
}

/** Compiled once at module load — cloned per-call to reset lastIndex */
const EXTRACTOR_PATTERNS: ExtractorPattern[] = ((): ExtractorPattern[] => {
  const raw: Array<{ regex: RegExp; contextHints: string[] }> = [
  // function declarations: function myFunc(
  {
    regex: /\bfunction\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g,
    contextHints: ["function", "functions"],
  },
  // arrow / const functions: const myFunc = (  OR  const myFunc = async (
  {
    regex: /\bconst\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s*)?\(/g,
    contextHints: ["function", "functions", "variable", "variables"],
  },
  // let / var declarations: let myVar =
  {
    regex: /\b(?:let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g,
    contextHints: ["variable", "variables"],
  },
  // class declarations: class MyClass
  {
    regex: /\bclass\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g,
    contextHints: ["class", "classes"],
  },
  // method definitions inside classes/objects: myMethod(
  {
    regex: /^\s{2,}([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/gm,
    contextHints: ["method", "methods", "function", "functions"],
  },
  // Jest/Vitest test names: it('my test', ...) / test('my test', ...)
  {
    regex: /\b(?:it|test)\s*\(\s*['"`]([^'"`]+)['"`]/g,
    contextHints: ["test", "tests", "test functions", "test names"],
  },
  // Java: method declarations — void myMethod( / public String myMethod(
  {
    regex: /\b(?:public|private|protected|static|void|[\w<>\[\]]+)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g,
    contextHints: ["method", "methods", "function", "functions"],
  },
  // Java JUnit test methods annotated with @Test (method on next line)
  {
    regex: /@Test[\s\S]{0,80}?\bvoid\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g,
    contextHints: ["test", "tests", "test functions", "test methods"],
  },
  ];
  return raw.map((p) => ({ source: p.regex.source, flags: p.regex.flags, contextHints: p.contextHints }));
})();

export function findViolations(
  document: vscode.TextDocument,
  rules: NamingRule[]
): Violation[] {
  if (rules.length === 0) return [];

  const text = document.getText();
  const violations: Violation[] = [];
  const seen = new Set<string>(); // avoid duplicate diagnostics for same identifier

  for (const pattern of EXTRACTOR_PATTERNS) {
    // Clone from pre-compiled source/flags to reset lastIndex without recompiling
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      const name = match[1];
      const dedupeKey = `${name}:${match.index}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const matchedRule = findApplicableRule(rules, pattern.contextHints);
      if (!matchedRule) continue;

      if (!matchesConvention(name, matchedRule.convention)) {
        const startPos = document.positionAt(match.index + match[0].indexOf(name));
        const endPos = startPos.translate(0, name.length);

        violations.push({
          name,
          range: new vscode.Range(startPos, endPos),
          rule: matchedRule,
          suggestion: suggestFix(name, matchedRule.convention),
        });
      }
    }
  }

  return violations;
}

/**
 * Finds the first rule whose context overlaps with the given hints.
 */
function findApplicableRule(
  rules: NamingRule[],
  hints: string[]
): NamingRule | undefined {
  return rules.find((rule) =>
    hints.some((hint) => rule.context.toLowerCase().includes(hint.toLowerCase()))
  );
}
