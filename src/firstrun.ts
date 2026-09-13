/**
 * First run, for someone who installed btrix and has never heard of pi.
 *
 * With no credentials configured, the runtime prints its own message naming
 * itself and a node_modules path. Detecting the situation at session start lets
 * btrix say something useful first.
 *
 * One pi-ism is unavoidable: `/login` is a built-in command, extension
 * commands that collide with a built-in name are filtered out, and there is no
 * API for triggering it. So the panel tells the user to type it.
 */

/** The slice of pi's ModelRegistry this needs, so tests need no harness. */
export interface AuthProbe {
  getAvailable(): { provider: string; id: string }[];
  hasConfiguredAuth(model: { provider: string; id: string }): boolean;
}

export interface AuthState {
  ready: boolean;
  /** A model with working credentials, when there is one. */
  model?: { provider: string; id: string };
  /** Providers that have models but no usable credential. */
  unauthenticated: string[];
}

/**
 * Look for any model we could actually call. Deliberately provider-agnostic:
 * with a subscription login the provider is whatever the user signed into, so
 * assuming Anthropic would be wrong for most of them.
 */
export function probeAuth(registry: AuthProbe): AuthState {
  let available: { provider: string; id: string }[] = [];
  try {
    available = registry.getAvailable() ?? [];
  } catch {
    available = [];
  }

  const usable = available.filter((m) => {
    try {
      return registry.hasConfiguredAuth(m);
    } catch {
      return false;
    }
  });

  return {
    ready: usable.length > 0,
    model: usable[0],
    unauthenticated: [...new Set(available.filter((m) => !usable.includes(m)).map((m) => m.provider))],
  };
}

export function firstRunPanel(state: AuthState): string[] {
  if (state.ready) return [];
  return [
    "btrix needs access to a language model before it can do anything.",
    "",
    "  Type  /login   to sign in with a Claude, ChatGPT or Copilot subscription,",
    "  or set an API key (for example ANTHROPIC_API_KEY) and start btrix again.",
    "",
    "Nothing is sent anywhere until you do. Crawling itself runs locally in a",
    "container and needs no account.",
  ];
}

/** Shown once credentials exist, so the user knows what they are talking to. */
export function readyHeader(state: AuthState, storeRoot: string): string[] {
  return [`btrix — web archiving with Browsertrix Crawler`, `store ${storeRoot} · ${modelLabel(state.model)}`];
}

export function modelLabel(model: { provider: string; id: string } | undefined): string {
  return model ? `${model.provider}/${model.id}` : "no model";
}
