import { NamingRule } from "../notion/parser";

/**
 * Checks whether a given identifier matches the expected convention.
 */
export function matchesConvention(
  name: string,
  convention: NamingRule["convention"]
): boolean {
  switch (convention) {
    case "camelCase":
      return /^[a-z][a-zA-Z0-9]*$/.test(name);
    case "PascalCase":
      return /^[A-Z][a-zA-Z0-9]*$/.test(name);
    case "snake_case":
      return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(name);
    case "UPPER_SNAKE":
      return /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(name);
    case "kebab-case":
      return /^[a-z][a-z0-9-]*$/.test(name);
  }
}

/**
 * Suggests the corrected name based on the required convention.
 */
export function suggestFix(
  name: string,
  convention: NamingRule["convention"]
): string {
  switch (convention) {
    case "camelCase":
      return toCamelCase(name);
    case "PascalCase":
      return toPascalCase(name);
    case "snake_case":
      return toSnakeCase(name);
    case "UPPER_SNAKE":
      return toSnakeCase(name).toUpperCase();
    case "kebab-case":
      return toSnakeCase(name).replace(/_/g, "-");
  }
}

// --- Conversion helpers ---

function tokenize(name: string): string[] {
  // Split on underscores, hyphens, and uppercase boundaries
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_\-]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

function toCamelCase(name: string): string {
  const tokens = tokenize(name);
  return tokens
    .map((t, i) => (i === 0 ? t : t[0].toUpperCase() + t.slice(1)))
    .join("");
}

function toPascalCase(name: string): string {
  return tokenize(name)
    .map((t) => t[0].toUpperCase() + t.slice(1))
    .join("");
}

function toSnakeCase(name: string): string {
  return tokenize(name).join("_");
}
