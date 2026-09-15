/**
 * Browser login profiles, for crawling sites behind a login.
 *
 * A profile is a tarball of browser state — including session cookies — made by
 * a person logging in by hand in a browser served over noVNC. btrix starts that
 * browser and puts the file in the right place; it never sees, stores or
 * forwards a credential, and it must never attempt the login itself.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileSize } from "./sizes.ts";
import { isSafeStoreName, type Store } from "./store.ts";

/** Where the crawler sees profiles, given the store is mounted at /crawls. */
export const CONTAINER_PROFILES = "/crawls/profiles";

export interface Profile {
  name: string;
  path: string;
  bytes?: number;
  modified?: Date;
  /** The value to put in a config's `profile:` key. */
  configValue: string;
}

export function listProfiles(store: Store): Profile[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(store.profilesDir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".tar.gz"))
    .sort()
    .map((f) => {
      const full = path.join(store.profilesDir, f);
      const name = f.replace(/\.tar\.gz$/, "");
      let modified: Date | undefined;
      try {
        modified = fs.statSync(full).mtime;
      } catch {
        modified = undefined;
      }
      return {
        name,
        path: full,
        bytes: fileSize(full),
        modified,
        configValue: `${CONTAINER_PROFILES}/${f}`,
      };
    });
}

export function findProfile(store: Store, name: string): Profile | undefined {
  const wanted = name.replace(/\.tar\.gz$/, "");
  return listProfiles(store).find((p) => p.name === wanted);
}

/** Profile names are used as filenames; keep them boring. */
export function safeProfileName(raw: string): string | undefined {
  const name = raw.trim().replace(/\.tar\.gz$/, "");
  return isSafeStoreName(name) ? name : undefined;
}
