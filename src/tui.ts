/**
 * Adapting our line builders to pi's tool renderers.
 *
 * A Component only has to produce lines for a width, so the same functions that
 * draw the widget can draw a tool result. That is the point of doing this: the
 * inventory table renders itself in the transcript, instead of being handed to
 * the model as text for it to paraphrase back.
 */

import type { Component } from "@earendil-works/pi-tui";

/** Matches an ANSI colour sequence, whose characters do not occupy columns. */
const ANSI = /\u001b\[[0-9;]*m/g;

const visibleLength = (s: string): number => s.replace(ANSI, "").length;

/**
 * A component rendering fixed lines. Lines carrying colour are passed through
 * untouched: their apparent length is not their column count, so wrapping them
 * by character would break the escapes.
 */
export function linesComponent(lines: string[], indent = ""): Component {
  return {
    // Static content, so there is nothing to recompute on invalidation.
    invalidate() {},
    render(width: number): string[] {
      const max = Math.max(20, width - indent.length);
      return lines.flatMap((line) => {
        if (visibleLength(line) <= max || ANSI.test(line)) return [indent + line];
        const parts: string[] = [];
        for (let i = 0; i < line.length; i += max) parts.push(indent + line.slice(i, i + max));
        return parts;
      });
    },
  };
}

/** Truncate to a column budget, accounting for colour sequences. */
export function ellipsis(text: string, max: number): string {
  if (visibleLength(text) <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}
