import type { ReactNode } from "react";

/**
 * Light JSON-like syntax tint for the rule block. Not a real parser —
 * it highlights strings, numbers, keywords, arrays, and comments so the
 * rule body reads like code without needing a heavy tokenizer.
 *
 * Colors match the handoff's dark-terminal palette (sage, amber, blue).
 */
export function syntaxTint(line: string): ReactNode {
  const trimmed = line.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("#")) {
    return <span style={{ color: "#9bd7b5" }}>{line}</span>;
  }

  const parts: ReactNode[] = [];
  const re = /("[^"]+")(\s*:\s*)("[^"]*"|\d+(?:\.\d+)?|true|false|null|\[[^\]]*\])?/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) parts.push(line.slice(last, m.index));
    parts.push(
      <span key={`k${m.index}`} style={{ color: "#f4c989" }}>
        {m[1]}
      </span>
    );
    parts.push(m[2]);
    if (m[3]) {
      const v = m[3];
      const color = /^".*"$/.test(v)
        ? "#9bd7b5"
        : /^(true|false|null)$/.test(v)
          ? "#e38a8a"
          : /^\[/.test(v)
            ? "#d2c1f0"
            : "#b5d9ff";
      parts.push(
        <span key={`v${m.index}`} style={{ color }}>
          {v}
        </span>
      );
    }
    last = m.index + m[0].length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts.length ? parts : line;
}
