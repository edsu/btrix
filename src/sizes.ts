/**
 * Disk numbers. Sizes shell out to `du`; free space uses `fs.statfs`.
 *
 * `du` beats walking the tree in JS on a large `archive/`, and the reason the
 * old plugin had to fold `du`/`df` into one script — every extra command was a
 * permission prompt — does not apply here.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Bytes used by a directory, or undefined if it does not exist. */
export async function dirSize(path: string): Promise<number | undefined> {
  if (!fs.existsSync(path)) return undefined;
  try {
    // -k for kibibytes: -h would mean parsing "1.2G" back into a number.
    const { stdout } = await exec("du", ["-sk", path], { timeout: 20_000 });
    const kb = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "", 10);
    return Number.isFinite(kb) ? kb * 1024 : undefined;
  } catch {
    return undefined;
  }
}

/** Bytes free on the filesystem holding `path`. */
export async function freeSpace(path = "."): Promise<number | undefined> {
  try {
    const s = await fs.promises.statfs(path);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return undefined;
  }
}

export function fileSize(path: string): number | undefined {
  try {
    return fs.statSync(path).size;
  } catch {
    return undefined;
  }
}

/** 1.2G / 840M / 12K — matches the shape the old scripts printed. */
export function humanBytes(n: number | undefined): string {
  if (n === undefined) return "-";
  const units = ["B", "K", "M", "G", "T"] as const;
  let v = n;
  for (let i = 0; i < units.length; i++) {
    if (v < 1024 || i === units.length - 1) {
      const u = units[i];
      return v >= 10 || u === "B" ? `${Math.round(v)}${u}` : `${v.toFixed(1)}${u}`;
    }
    v /= 1024;
  }
  return `${n}B`;
}

/** 45s / 4m / 2h10m / 3d — for durations and ETAs. */
export function humanDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return h < 10 && m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
