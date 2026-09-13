/**
 * The startup wordmark.
 *
 * Set in figlet's `small` font with kerning, then baked in as a literal: there
 * is no figlet at runtime, and the font happens to be pure ASCII, so it needs
 * no fallback for terminals without a UTF-8 locale.
 *
 * A different colour scheme each start, chosen at random. It costs nothing and
 * makes opening the tool mildly pleasant, which is worth something for
 * something you open hundreds of times.
 */

const ESC = "\u001b";
const RESET = `${ESC}[0m`;

/** figlet -f small -k btrix */
export const WORDMARK = [
  " _     _         _",
  "| |__ | |_  _ _ (_)__ __",
  "| '_ \\|  _|| '_|| |\\ \\ /",
  "|_.__/ \\__||_|  |_|/_\\_\\",
];

export type Rgb = [number, number, number];

export interface Scheme {
  name: string;
  from: Rgb;
  to: Rgb;
}

/**
 * Gradients that read well on both light and dark backgrounds: mid-tone, and
 * never running through a colour the terminal might use for errors.
 */
export const SCHEMES: Scheme[] = [
  { name: "amber → rose", from: [235, 175, 75], to: [220, 90, 120] },
  { name: "blue → teal", from: [70, 130, 220], to: [40, 200, 190] },
  { name: "teal → green", from: [45, 190, 200], to: [120, 205, 120] },
  { name: "violet → cyan", from: [150, 120, 230], to: [70, 200, 215] },
  { name: "slate → amber", from: [120, 140, 165], to: [230, 175, 80] },
  { name: "rose → violet", from: [225, 105, 145], to: [150, 120, 235] },
  { name: "green → amber", from: [110, 200, 125], to: [235, 180, 80] },
];

/** Injectable randomness, so a test can pin the scheme. */
export function pickScheme(random: () => number = Math.random, schemes: Scheme[] = SCHEMES): Scheme {
  const i = Math.min(schemes.length - 1, Math.max(0, Math.floor(random() * schemes.length)));
  return schemes[i]!;
}

/**
 * Whether the terminal can do 24-bit colour. Without it, the escape codes
 * would either be ignored or approximated badly, so we use a theme colour
 * instead and let the theme decide.
 */
export function supportsTruecolor(env: Record<string, string | undefined> = process.env): boolean {
  const flag = (env.COLORTERM ?? "").toLowerCase();
  if (flag === "truecolor" || flag === "24bit") return true;
  return ["ghostty", "iterm.app", "wezterm", "vscode"].includes((env.TERM_PROGRAM ?? "").toLowerCase());
}

const lerp = (from: Rgb, to: Rgb, t: number): Rgb =>
  from.map((f, i) => Math.round(f + (to[i]! - f) * t)) as Rgb;

/**
 * Colour the wordmark along a horizontal gradient. Spaces are left uncoloured
 * so the escape sequences stay off the padding, which keeps the side-by-side
 * layout measurable.
 */
export function colourWordmark(lines: string[], scheme: Scheme): string[] {
  const width = Math.max(...lines.map((l) => l.length));
  return lines.map((line) => {
    let out = "";
    let pen: string | undefined;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (ch === " ") {
        if (pen) {
          out += RESET;
          pen = undefined;
        }
        out += ch;
        continue;
      }
      const [r, g, b] = lerp(scheme.from, scheme.to, width > 1 ? i / (width - 1) : 0);
      const next = `${ESC}[38;2;${r};${g};${b}m`;
      if (next !== pen) {
        out += next;
        pen = next;
      }
      out += ch;
    }
    return pen ? out + RESET : out;
  });
}

export interface WordmarkOptions {
  /** Falls back to this when the terminal cannot do 24-bit colour. */
  plain?: (line: string) => string;
  truecolor?: boolean;
  random?: () => number;
}

/** The wordmark, coloured however this terminal and this start allow. */
export function wordmarkLines(opts: WordmarkOptions = {}): { lines: string[]; scheme?: Scheme } {
  const truecolor = opts.truecolor ?? supportsTruecolor();
  if (!truecolor) {
    return { lines: opts.plain ? WORDMARK.map(opts.plain) : [...WORDMARK] };
  }
  const scheme = pickScheme(opts.random);
  return { lines: colourWordmark(WORDMARK, scheme), scheme };
}
