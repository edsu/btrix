/**
 * Adapting our line builders to pi's renderers.
 *
 * A Component only has to produce lines for a width, so the same functions that
 * draw the widget can draw a tool result. That is the point of doing this: the
 * inventory table renders itself in the transcript, instead of being handed to
 * the model as text for it to paraphrase back.
 *
 * Every line must fit the width it is given — pi throws on a component that
 * overruns, which is right, since an overrun corrupts the whole frame. Wrapping
 * therefore happens here, using pi's own ANSI-aware helpers rather than
 * counting characters: colour sequences occupy no columns, so a line's length
 * and its width are different numbers.
 */

import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface LinesOptions {
  indent?: string;
  /**
   * What to do with a line that does not fit.
   *
   * "wrap" for transcript content, where an over-long line is usually a url
   * somebody needs to copy and cutting it off would make it useless. "clip"
   * for the progress widget, which sits above the editor at a fixed height —
   * there, a line that wraps pushes the editor down on every repaint.
   */
  overflow?: "wrap" | "clip";
}

/** A component rendering fixed lines, fitted to the viewport. */
export function linesComponent(lines: string[], options: LinesOptions | string = {}): Component {
  const { indent = "", overflow = "wrap" } = typeof options === "string" ? { indent: options } : options;
  return {
    // Static content, so there is nothing to recompute on invalidation.
    invalidate() {},
    render(width: number): string[] {
      const max = Math.max(8, width - visibleWidth(indent));
      return lines.flatMap((line) => {
        if (visibleWidth(line) <= max) return [indent + line];
        if (overflow === "clip") return [indent + truncateToWidth(line, max)];
        return wrapTextWithAnsi(line, max).map((part) => indent + part);
      });
    },
  };
}

/** Truncate to a column budget, accounting for colour sequences. */
export function ellipsis(text: string, max: number): string {
  return visibleWidth(text) <= max ? text : truncateToWidth(text, max);
}
