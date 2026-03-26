import * as vscode from "vscode";
import { NamingRule } from "../notion/parser";
import { matchesConvention, suggestFix } from "./rules";

export interface Violation {
  name: string;
  range: vscode.Range;
  rule: NamingRule;
  suggestion: string;
}

export interface AdditionalDiagnostic {
  message: string;
  range: vscode.Range;
  severity: vscode.DiagnosticSeverity;
  code: string;
}

/**
 * Additional coding standards beyond naming conventions.
 * Read from companyStandards.additionalRules in settings.
 */
export interface AdditionalRules {
  /** Warn when console.log / console.debug / console.info are used */
  disallowConsoleLog: boolean;
  /** Warn on lines exceeding this length. 0 = disabled */
  maxLineLength: number;
  /** Enforce 'I' prefix on interfaces: "required" | "forbidden" | "optional" */
  interfacePrefix: "required" | "forbidden" | "optional";
  /** Warn when TODO/FIXME/HACK comments are left in the code */
  disallowTodoComments: boolean;
  /** Warn when empty catch blocks are detected */
  disallowEmptyCatch: boolean;
  /** Warn when 'any' type is used explicitly in TypeScript */
  disallowExplicitAny: boolean;
}

export const DEFAULT_ADDITIONAL_RULES: AdditionalRules = {
  disallowConsoleLog:   false,
  maxLineLength:        0,
  interfacePrefix:      "optional",
  disallowTodoComments: false,
  disallowEmptyCatch:   false,
  disallowExplicitAny:  false,
};

// ─── Extractor patterns ──────────────────────────────────────────────────────

interface ExtractorPattern {
  source: string;
  flags: string;
  contextHints: string[];
}

/** Compiled once at module load — cloned per-call to reset lastIndex */
const EXTRACTOR_PATTERNS: ExtractorPattern[] = ((): ExtractorPattern[] => {
  const raw: Array<{ regex: RegExp; contextHints: string[] }> = [
    // ── Functions ──────────────────────────────────────────────────────────
    { regex: /\bfunction\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g,
      contextHints: ["function", "functions"] },
    { regex: /\bconst\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s*)?\(/g,
      contextHints: ["function", "functions", "variable", "variables", "constants"] },

    // ── Variables ──────────────────────────────────────────────────────────
    { regex: /\b(?:let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g,
      contextHints: ["variable", "variables"] },

    // ── Constants ──────────────────────────────────────────────────────────
    // const NAME = (non-function assignment)
    { regex: /\bconst\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?!(?:async\s*)?\()/g,
      contextHints: ["constant", "constants"] },

    // ── Classes ────────────────────────────────────────────────────────────
    { regex: /\bclass\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g,
      contextHints: ["class", "classes"] },

    // ── Interfaces ─────────────────────────────────────────────────────────
    { regex: /\binterface\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g,
      contextHints: ["interface", "interfaces"] },

    // ── Type aliases ───────────────────────────────────────────────────────
    { regex: /\btype\s+([A-Za-z_$][a-zA-Z0-9_$]*)\s*(?:<[^>]*>)?\s*=/g,
      contextHints: ["type", "types", "type alias", "type aliases"] },

    // ── Enums ──────────────────────────────────────────────────────────────
    { regex: /\benum\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g,
      contextHints: ["enum", "enums"] },

    // ── Enum members: indented identifier followed by = , or }  ────────────
    { regex: /^\s{2,}([A-Za-z_$][a-zA-Z0-9_$]*)\s*(?:=|,|})/gm,
      contextHints: ["enum member", "enum members"] },

    // ── Class methods (indented) ───────────────────────────────────────────
    { regex: /^\s{2,}(?:(?:public|private|protected|static|async|override|readonly)\s+)*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/gm,
      contextHints: ["method", "methods", "function", "functions"] },

    // ── Private fields ─────────────────────────────────────────────────────
    { regex: /\bprivate\s+(?:readonly\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[=:;]/g,
      contextHints: ["private field", "private fields"] },

    // ── Function parameters (full param list captured) ────────────────────
    { regex: /\bfunction\s+\w+\s*\(([^)]*)\)/g,
      contextHints: ["parameter", "parameters"] },

    // ── Test functions (Jest / Vitest) ────────────────────────────────────
    { regex: /\b(?:it|test)\s*\(\s*['"`]([^'"`]+)['"`]/g,
      contextHints: ["test", "tests", "test function", "test functions", "test names"] },

    // ── JUnit @Test methods (Java) ────────────────────────────────────────
    { regex: /@Test[\s\S]{0,80}?\bvoid\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g,
      contextHints: ["test", "tests", "test function", "test functions", "test methods"] },

    // ── Java method declarations ──────────────────────────────────────────
    { regex: /\b(?:public|private|protected|static|void|[\w<>\[\]]+)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g,
      contextHints: ["method", "methods", "function", "functions"] },
  ];

  return raw.map((p) => ({
    source:       p.regex.source,
    flags:        p.regex.flags,
    contextHints: p.contextHints,
  }));
})();

// ─── Naming violations ───────────────────────────────────────────────────────

export function findViolations(
  document: vscode.TextDocument,
  rules: NamingRule[]
): Violation[] {
  if (rules.length === 0) return [];

  const text       = document.getText();
  const violations: Violation[] = [];
  const seen       = new Set<string>();

  for (const pattern of EXTRACTOR_PATTERNS) {
    const regex         = new RegExp(pattern.source, pattern.flags);
    const isParamPattern = pattern.contextHints.includes("parameter");
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      if (isParamPattern) {
        const paramNames = extractParamNames(match[1]);
        for (const paramName of paramNames) {
          const dedupeKey = `${paramName}:param:${match.index}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);

          const matchedRule = findApplicableRule(rules, pattern.contextHints);
          if (!matchedRule) continue;

          if (!matchesConvention(paramName, matchedRule.convention)) {
            const nameOffset = text.indexOf(paramName, match.index);
            const startPos   = document.positionAt(nameOffset);
            violations.push({
              name:       paramName,
              range:      new vscode.Range(startPos, startPos.translate(0, paramName.length)),
              rule:       matchedRule,
              suggestion: suggestFix(paramName, matchedRule.convention),
            });
          }
        }
        continue;
      }

      const name      = match[1];
      const dedupeKey = `${name}:${match.index}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const matchedRule = findApplicableRule(rules, pattern.contextHints);
      if (!matchedRule) continue;

      if (!matchesConvention(name, matchedRule.convention)) {
        const startPos = document.positionAt(match.index + match[0].indexOf(name));
        const endPos   = startPos.translate(0, name.length);

        violations.push({
          name,
          range:      new vscode.Range(startPos, endPos),
          rule:       matchedRule,
          suggestion: suggestFix(name, matchedRule.convention),
        });
      }
    }
  }

  return violations;
}

function extractParamNames(paramList: string): string[] {
  return paramList
    .split(",")
    .map((p) => p.trim().split(/[=:?]/)[0].trim())
    .filter((p) => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(p) && p.length > 0);
}

function findApplicableRule(rules: NamingRule[], hints: string[]): NamingRule | undefined {
  return rules.find((rule) =>
    hints.some((hint) => rule.context.toLowerCase().includes(hint.toLowerCase()))
  );
}

// ─── Additional coding-standard violations ───────────────────────────────────

/**
 * Checks additional coding standards beyond naming conventions.
 * Each rule is independently enabled/disabled via settings.
 */
export function findAdditionalViolations(
  document: vscode.TextDocument,
  rules: AdditionalRules
): AdditionalDiagnostic[] {
  const diags: AdditionalDiagnostic[] = [];
  const text  = document.getText();
  const lines = text.split("\n");
  const lang  = document.languageId;
  const isTS  = lang === "typescript" || lang === "typescriptreact";

  // ── console.log / console.debug / console.info ────────────────────────────
  if (rules.disallowConsoleLog) {
    const rx = /\bconsole\.(log|debug|info)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(text)) !== null) {
      const pos = document.positionAt(m.index);
      const end = document.positionAt(m.index + m[0].length - 1);
      diags.push({
        message:  `[Company Standard] console.${m[1]}() should not be used in production code.`,
        range:    new vscode.Range(pos, end),
        severity: vscode.DiagnosticSeverity.Warning,
        code:     "no-console",
      });
    }
  }

  // ── Max line length ────────────────────────────────────────────────────────
  if (rules.maxLineLength > 0) {
    lines.forEach((line, i) => {
      if (line.length > rules.maxLineLength) {
        const start = new vscode.Position(i, rules.maxLineLength);
        const end   = new vscode.Position(i, line.length);
        diags.push({
          message:  `[Company Standard] Line length ${line.length} exceeds the ${rules.maxLineLength}-character limit.`,
          range:    new vscode.Range(start, end),
          severity: vscode.DiagnosticSeverity.Information,
          code:     "max-line-length",
        });
      }
    });
  }

  // ── Interface prefix ──────────────────────────────────────────────────────
  if (rules.interfacePrefix !== "optional" && isTS) {
    const rx = /\binterface\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(text)) !== null) {
      const name       = m[1];
      const hasIPrefix = name.startsWith("I") && name.length > 1 && /^[A-Z]/.test(name[1]);

      if (rules.interfacePrefix === "required" && !hasIPrefix) {
        const pos = document.positionAt(m.index + m[0].indexOf(name));
        diags.push({
          message:  `[Company Standard] Interface "${name}" must use the "I" prefix (e.g. "I${name}").`,
          range:    new vscode.Range(pos, pos.translate(0, name.length)),
          severity: vscode.DiagnosticSeverity.Warning,
          code:     "interface-prefix-required",
        });
      } else if (rules.interfacePrefix === "forbidden" && hasIPrefix) {
        const pos = document.positionAt(m.index + m[0].indexOf(name));
        diags.push({
          message:  `[Company Standard] Interface "${name}" must NOT use the "I" prefix.`,
          range:    new vscode.Range(pos, pos.translate(0, name.length)),
          severity: vscode.DiagnosticSeverity.Warning,
          code:     "interface-prefix-forbidden",
        });
      }
    }
  }

  // ── TODO / FIXME / HACK comments ──────────────────────────────────────────
  if (rules.disallowTodoComments) {
    const rx = /\/\/\s*(TODO|FIXME|HACK|XXX)\b/gi;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(text)) !== null) {
      const pos = document.positionAt(m.index);
      const end = document.positionAt(m.index + m[0].length);
      diags.push({
        message:  `[Company Standard] ${m[1].toUpperCase()} comment should be resolved before merging.`,
        range:    new vscode.Range(pos, end),
        severity: vscode.DiagnosticSeverity.Information,
        code:     "no-todo-comments",
      });
    }
  }

  // ── Empty catch blocks ─────────────────────────────────────────────────────
  if (rules.disallowEmptyCatch) {
    const rx = /\bcatch\s*\([^)]*\)\s*\{\s*\}/g;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(text)) !== null) {
      const pos = document.positionAt(m.index);
      const end = document.positionAt(m.index + m[0].length);
      diags.push({
        message:  `[Company Standard] Empty catch block detected. Handle or log the error.`,
        range:    new vscode.Range(pos, end),
        severity: vscode.DiagnosticSeverity.Warning,
        code:     "no-empty-catch",
      });
    }
  }

  // ── Explicit 'any' type (TypeScript only) ──────────────────────────────────
  if (rules.disallowExplicitAny && isTS) {
    const rx = /:\s*any\b/g;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(text)) !== null) {
      const pos = document.positionAt(m.index);
      const end = document.positionAt(m.index + m[0].length);
      diags.push({
        message:  `[Company Standard] Explicit "any" type should be avoided. Use a specific type or "unknown".`,
        range:    new vscode.Range(pos, end),
        severity: vscode.DiagnosticSeverity.Warning,
        code:     "no-explicit-any",
      });
    }
  }

  return diags;
}
