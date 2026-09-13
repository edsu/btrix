/**
 * Native terminal notifications, for a crawl that finishes hours later.
 *
 * A long crawl currently announces itself to a window nobody is looking at.
 * Terminals expose this over escape sequences — OSC 777 for Ghostty, iTerm2,
 * WezTerm and rxvt; OSC 99 for Kitty — so it needs no dependency and no
 * platform integration, just the right bytes.
 */

// Escapes rather than literal control bytes, so the source stays greppable.
const ESC = "\u001b";
const BEL = "\u0007";
const ST = `${ESC}\\`;

export interface NotifyEnv {
  TERM?: string;
  TERM_PROGRAM?: string;
  KITTY_WINDOW_ID?: string;
}

export type NotifyProtocol = "osc777" | "osc99" | "none";

/** Which protocol, if any, this terminal understands. */
export function detectProtocol(env: NotifyEnv = process.env): NotifyProtocol {
  if (env.KITTY_WINDOW_ID || env.TERM === "xterm-kitty") return "osc99";
  const program = (env.TERM_PROGRAM ?? "").toLowerCase();
  if (["ghostty", "iterm.app", "wezterm"].includes(program)) return "osc777";
  if ((env.TERM ?? "").startsWith("rxvt")) return "osc777";
  // Unknown terminal: writing escape sequences blind can print gibberish into
  // the transcript, which is worse than staying quiet.
  return "none";
}

/** Semicolons and escapes would terminate the sequence early. */
function clean(s: string): string {
  return s
    .split("")
    .map((c) => (c === ";" || c === "\\" || c.charCodeAt(0) < 0x20 ? " " : c))
    .join("")
    .trim();
}

export function encode(protocol: NotifyProtocol, title: string, body: string): string | undefined {
  const t = clean(title);
  const b = clean(body);
  if (protocol === "osc777") return `${ESC}]777;notify;${t};${b}${BEL}`;
  if (protocol === "osc99") return `${ESC}]99;i=1:d=0;${t}${ST}${ESC}]99;i=1:p=body;${b}${ST}`;
  return undefined;
}

/**
 * Fire and forget. Never throws, and stays silent on terminals that would not
 * understand rather than risking noise in the transcript.
 */
export function notifyDesktop(title: string, body: string, env: NotifyEnv = process.env): boolean {
  const seq = encode(detectProtocol(env), title, body);
  if (!seq) return false;
  try {
    process.stdout.write(seq);
    return true;
  } catch {
    return false;
  }
}
