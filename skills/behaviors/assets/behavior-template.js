// Browsertrix Crawler custom behavior — starting template.
//
// Drives a JS interaction (here: a "Load More" button) so the crawler can reach
// content that isn't in the initial HTML, and — crucially — queues each revealed
// URL with addLink() so those pages actually get crawled (see the skill guide
// §3: link extraction runs BEFORE behaviors).
//
// Adapt: the class name/id, the isMatch() regex, the CLICK selector, the batch
// "loaded" signal, and the ARTICLE link selector. Pair with a config that sets
// `alwaysAddBehaviorLinks: true` (and usually `extraHops: 0`).
class MyLoadMoreBehavior {
  static id = "MyLoadMoreBehavior";

  static isMatch() {
    // Scope tightly — this runs on every page the crawler loads.
    return !!window.location.href.match(/example\.com\/some-section\//);
  }

  static init() {
    return {};
  }

  async *run(ctx) {
    const { sleep, addLink } = ctx.Lib;

    const CLICK = "div.load-more > a"; // the control to click
    const ARTICLE = 'a.article[href^="https://example.com/"]'; // links to queue
    const maxClicks = 5000; // hard safety cap so we never loop forever
    const batchTimeoutMs = 30000; // max wait for one batch to load

    // Queue any not-yet-seen article links currently in the DOM. Called after
    // every batch so a behaviorTimeout mid-run doesn't lose progress.
    const seen = new Set();
    const queue = () => {
      document.querySelectorAll(ARTICLE).forEach((a) => {
        const url = a.href.split("#")[0];
        if (seen.has(url)) return;
        seen.add(url);
        addLink(url);
      });
    };

    for (let i = 0; i < maxClicks; i++) {
      const link = document.querySelector(CLICK);
      if (!link) {
        queue();
        yield ctx.Lib.getState(ctx, `done (${seen.size} queued)`, "clicks");
        return;
      }

      // Capture a piece of state that changes when a batch loads, so we can
      // detect completion instead of guessing with a fixed sleep. If the
      // control has no such attribute, fall back to counting DOM items.
      const before = link.getAttribute("data-next-cursor");
      link.scrollIntoView({ block: "center" });
      await sleep(3000); // be polite; let things settle
      link.click();
      yield ctx.Lib.getState(ctx, `clicked (batch ${i + 1})`, "clicks");

      const start = Date.now();
      while (Date.now() - start < batchTimeoutMs) {
        await sleep(1500);
        const cur = document.querySelector(CLICK);
        if (!cur) break; // control gone -> next loop iteration finishes
        if (cur.getAttribute("data-next-cursor") !== before) break; // new batch
      }

      queue();
    }

    queue();
    yield ctx.Lib.getState(ctx, `hit click cap (${seen.size} queued)`, "clicks");
  }
}
