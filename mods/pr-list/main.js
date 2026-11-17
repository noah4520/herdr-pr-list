// PR List: GitHub pull requests through the person's own `gh` login. The PR for the
// focused terminal's branch, their own open PRs, and PRs waiting on their review.
// Refreshes when the focused folder changes, on the refresh button, and on a chosen
// interval (default 5 min, or off) while it is shown. Clicking a PR opens it in the
// browser.
//
// A layout places it twice: the list as a block in the side panel stack (next to Files
// and Changes), and its own PRs button as a block with props { button: true } after the
// tab bar. It also works as a plain block anywhere, where it counts as always shown.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, theme, layout, checking, props, run, shared, setShared } from "herdr";

const MOD = "pr-list";

// Auto-refresh choices in minutes; 0 is off. Clicking the interval cycles them.
const EVERY = [2, 5, 10, 15, 30, 0];
const DEFAULT_EVERY = 5;

const QUERY = `
fragment P on PullRequest {
  number title url isDraft reviewDecision headRefName
  repository { name }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}
query {
  review: search(query: "is:pr is:open review-requested:@me archived:false sort:updated-desc", type: ISSUE, first: 20) { nodes { ...P } }
  mine: search(query: "is:pr is:open author:@me archived:false sort:updated-desc", type: ISSUE, first: 20) { nodes { ...P } }
}`;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Same rule as Herdr's Files panel: the focused pane's folder, else the space's.
function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder || null, on };
}

// Shown: in the side panel stack, when that panel is open on this mod's block; placed
// anywhere else (a sidebar column, a pane), always.
const shown = () => { const m = mine(); return m.id ? m.on : true; };

// The mod's own panel button: a block with props { button: true } placed after the tab
// bar. It finds this mod's block in the layout's panel stack and shows or hides it, so
// the button comes with the mod, whatever tab bar the layout uses.
// props.radius is the pill's corner (default 6, as Herdr's own panel buttons).
// props.divider: false drops the line under it, for a tab bar that has none; by default
// it continues the divider Herdr's tab bar draws along its bottom edge.
function mine() {
  const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
  const block = body?.children?.find(c => c.content?.mod === MOD && !c.content?.props?.button);
  return { panel, id: block?.id ?? null, on: Boolean(block && panel && !panel.hidden && body.active === block.id) };
}

function panelButton(t, label, icon) {
  const { id, on } = mine();
  return h_flex().size_full().items_center().bg(t.chrome)
    .when(props()?.divider !== false, el => el.border_b(1).border_color(t.border))
    .child(h_flex().id(`${MOD}-button`).h(26).px(8).gap(5).flex_none().items_center().rounded(props()?.radius ?? 6)
      .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
      .hover(s => s.bg(t.hover)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => {
        if (!id) return;
        if (on) { run("layout.hide", { id: "panel" }); return; }
        // The tab bar remembers a space's panel only if it's listed here.
        const known = shared("workspace.panels") ?? ["files", "changes"];
        if (!known.includes(id)) setShared("workspace.panels", [...known, id]);
        run("layout.select", { stack: "panel-body", child: id });
        run("layout.show", { id: "panel" });
      })
      .child(svg(icon).size(14)).child(label));
}

// GraphQL and `gh pr view` name check states differently; fold both into four.
function checks(state) {
  if (!state) return null;
  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(state)) return "pass";
  if (["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"].includes(state)) return "running";
  return "fail";
}

function rollup(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const states = list.map(c => c.status && c.status !== "COMPLETED" ? "PENDING" : (c.conclusion || c.state || "PENDING"));
  if (states.some(s => checks(s) === "fail")) return "fail";
  if (states.some(s => checks(s) === "running")) return "running";
  return "pass";
}

// A theme color with its own alpha replaced: some theme colors already carry one
// (dim is #ffffff80), so appending another two digits makes an invalid literal.
function tint(color, alpha) {
  let hex = String(color ?? "").replace(/^#/, "");
  if (hex.length === 3 || hex.length === 4) hex = hex.slice(0, 3).split("").map(c => c + c).join("");
  return /^[0-9a-f]{6}/i.test(hex) ? `#${hex.slice(0, 6)}${alpha}` : color;
}

const REVIEW = {
  APPROVED: ["Approved", "done"],
  CHANGES_REQUESTED: ["Changes requested", "blocked"],
  REVIEW_REQUIRED: ["Review required", "dim"],
};

function fromSearch(n) {
  const commit = n.commits?.nodes?.[0]?.commit;
  return {
    number: n.number, title: n.title, url: n.url, draft: n.isDraft, repo: n.repository?.name,
    review: n.reviewDecision, checks: checks(commit?.statusCheckRollup?.state), state: "OPEN",
  };
}

export default class PRList extends View {
  init(_props, cx) {
    if (props()?.button) return;
    this.lists = null;       // { review: [], mine: [] }
    this.branch = null;      // { branch, pr, error }
    this.error = null;
    this.loading = false;
    this.at = null;
    this.where = null;
    this.visible = false;
    try { this.folded = new Set(JSON.parse(localStorage.getItem("folded") ?? "[]")); } catch { this.folded = new Set(); }
    const saved = Number(localStorage.getItem("every"));
    this.every = EVERY.includes(saved) && localStorage.getItem("every") !== null ? saved : DEFAULT_EVERY;
    if (checking()) return;
    // A one-minute tick that refreshes once the chosen interval has passed, so a new
    // choice applies at once without restarting the timer.
    cx.timer.every(60000, (cx) => {
      if (this.every && shown() && (!this.at || Date.now() - this.at.getTime() >= this.every * 60000 - 5000)) this.refresh(cx);
    });
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    const { cwd, on } = location();
    cx.spawn(async (cx) => {
      const [lists, branch] = await Promise.all([this.loadLists(), this.loadBranch(cwd, on)]);
      Object.assign(this, lists);
      this.branch = branch;
      this.at = new Date();
      this.loading = false;
      cx.notify();
    });
  }

  async loadLists() {
    try {
      const r = await exec("gh", ["api", "graphql", "-f", `query=${QUERY}`], { timeout: 30000 });
      if (r.code !== 0) return { error: r.stderr.trim().split("\n")[0] || "gh failed" };
      const d = JSON.parse(r.stdout).data;
      return {
        error: null,
        lists: { review: d.review.nodes.filter(n => n.url).map(fromSearch), mine: d.mine.nodes.filter(n => n.url).map(fromSearch) },
      };
    } catch (e) {
      return { error: String(e).includes("not found") ? "GitHub CLI (gh) isn't installed." : String(e) };
    }
  }

  async loadBranch(cwd, on) {
    if (!cwd) return null;
    if (on) return { branch: null, pr: null, note: "Remote space: run gh there." };
    try {
      const b = await exec("git", ["branch", "--show-current"], { cwd, timeout: 10000 });
      if (b.code !== 0) return null;
      const branch = b.stdout.trim();
      if (!branch) return { branch: null, pr: null, note: "Detached HEAD" };
      const r = await exec("gh", ["pr", "view", "--json", "number,title,url,state,isDraft,reviewDecision,statusCheckRollup,mergeable,headRefName"], { cwd, timeout: 30000 });
      if (r.code !== 0) return { branch, pr: null, note: /no pull requests found/i.test(r.stderr) ? null : r.stderr.trim().split("\n")[0] };
      const p = JSON.parse(r.stdout);
      return {
        branch,
        pr: {
          number: p.number, title: p.title, url: p.url, draft: p.isDraft, state: p.state,
          review: p.reviewDecision, checks: rollup(p.statusCheckRollup), conflict: p.mergeable === "CONFLICTING",
        },
      };
    } catch (e) {
      return { branch: null, pr: null, note: String(e) };
    }
  }

  // The default browser: `open` on macOS, `xdg-open` elsewhere.
  open(url) { exec("sh", ["-c", 'open "$1" 2>/dev/null || xdg-open "$1"', "open", url]); }

  badge(text, color) {
    return div().flex_none().px(6).h(18).flex().items_center().rounded(5)
      .bg(tint(color, "26")).text_size(10.5).font_semibold().text_color(color).child(text);
  }

  meta(pr, t, withRepo) {
    const review = REVIEW[pr.review];
    const check = { pass: ["✓ Checks", t.done], fail: ["✗ Checks", t.blocked], running: ["● Checks", t.working] }[pr.checks];
    return h_flex().gap(6).items_center().min_w(0).text_size(11).text_color(t.dim)
      .child(div().flex_none().child(withRepo ? `${pr.repo} #${pr.number}` : `#${pr.number}`))
      .when(pr.draft, el => el.child(this.badge("Draft", t.dim)))
      .when(pr.state === "MERGED", el => el.child(this.badge("Merged", t.accent)))
      .when(pr.state === "CLOSED", el => el.child(this.badge("Closed", t.dim)))
      .when(Boolean(review) && pr.state === "OPEN", el => el.child(div().flex_none().text_color(t[review[1]]).child(review[0])))
      .when(Boolean(check), el => el.child(div().flex_none().text_color(check[1]).child(check[0])))
      .when(Boolean(pr.conflict), el => el.child(div().flex_none().text_color(t.blocked).child("Conflict")));
  }

  row(pr, t, key) {
    return v_flex().id(`${key}-${pr.repo}-${pr.number}`).gap(3).px(10).py(7).rounded(8).cursor_pointer()
      .hover(s => s.bg(t.hover)).on_click(() => this.open(pr.url))
      .child(div().text_size(12.5).text_color(t.foreground).truncate().child(pr.title))
      .child(this.meta(pr, t, true));
  }

  // A section header folds its section, like the agents list's groups: the chevron
  // points down while open and right while folded, and the choice is remembered.
  section(id, title, count, t) {
    const open = !this.folded.has(id);
    return h_flex().id(`gh-sec-${id}`).px(14).pt(14).pb(4).gap(6).items_center().text_size(11).text_color(t.dim)
      .cursor_pointer().hover(s => s.text_color(t.foreground))
      .on_click((_e, cx) => {
        open ? this.folded.add(id) : this.folded.delete(id);
        localStorage.setItem("folded", JSON.stringify([...this.folded]));
        cx.notify();
      })
      .child(div().font_semibold().child(title))
      .when(count !== null, el => el.child(div().child(String(count))))
      .child(div().flex_1())
      .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none());
  }

  open_(id) { return !this.folded.has(id); }

  render(cx) {
    const t = theme();
    if (props()?.button) return panelButton(t, "PRs", "mods/pr-list/pr.svg");
    // Load when the panel first shows, and again when the focused folder changes.
    const visible = shown(), where = JSON.stringify(location());
    if (!checking() && visible && (!this.visible || where !== this.where)) {
      this.where = where;
      cx.timer.after(0, (cx) => this.refresh(cx));
    }
    this.visible = visible;

    const b = this.branch, review = this.lists?.review ?? [], mine = this.lists?.mine ?? [];
    const pad = (n) => String(n).padStart(2, "0");
    const time = this.at ? `${pad(this.at.getHours())}:${pad(this.at.getMinutes())}` : null;
    return v_flex().size_full().min_h(0).text_color(t.foreground)
      .child(h_flex().h(42).flex_none().pl(14).pr(8).items_center().gap(6)
        .child(div().flex_1().text_size(13).font_semibold().child("Pull requests"))
        .when(Boolean(time), el => el.child(div().id("gh-time").text_size(11).text_color(t.dim)
          .tooltip("Last updated").child(this.loading ? "Updating…" : time)))
        .child(div().id("gh-every").px(6).h(20).flex().items_center().rounded(5).text_size(11)
          .border_1().border_color(t.border).text_color(t.muted).cursor_pointer()
          .hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip(this.every ? `Auto-refresh every ${this.every} min · click to change` : "Auto-refresh off · click to change")
          .on_click((_e, cx) => {
            this.every = EVERY[(EVERY.indexOf(this.every) + 1) % EVERY.length];
            localStorage.setItem("every", String(this.every));
            cx.notify();
          })
          .child(this.every ? `${this.every}m` : "Off"))
        .child(div().id("gh-refresh").size(26).flex().items_center().justify_center().rounded(6).text_color(t.muted)
          .hover(s => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.refresh(cx))
          .child(svg("mods/pr-list/refresh.svg").size(14).when(this.loading, el => el.spin(900)))))
      .child(v_flex().id("gh-list").flex_1().min_h(0).overflow_y_scrollbar().pb(10)
        .when(Boolean(this.error), el => el.child(div().px(14).py(8).text_size(12).text_color(t.blocked).child(this.error)))
        .when(Boolean(b), el => el
          .child(this.section("branch", "This branch", null, t))
          .when(this.open_("branch"), el => el.child(b.pr
            ? v_flex().id("gh-current").mx(6).gap(4).px(10).py(9).rounded(10).cursor_pointer()
              .bg(t.raised).border_1().border_color(t.border).hover(s => s.bg(t.hover))
              .on_click(() => this.open(b.pr.url))
              .child(div().text_size(13).font_semibold().text_color(t.foreground).child(b.pr.title))
              .child(this.meta(b.pr, t, false))
            : div().px(14).py(4).text_size(12).text_color(t.dim)
              .child(b.note ?? (b.branch ? `No PR for ${b.branch}` : "Not on a branch")))))
        .child(this.section("mine", "Your open PRs", this.lists ? mine.length : null, t))
        .when(this.open_("mine"), el => el
          .when(Boolean(this.lists) && mine.length === 0, el => el.child(div().px(14).py(4).text_size(12).text_color(t.dim).child("No open PRs.")))
          .child(v_flex().px(4).children(mine.map(pr => this.row(pr, t, "mine")))))
        .child(this.section("review", "Waiting on your review", this.lists ? review.length : null, t))
        .when(this.open_("review"), el => el
          .when(Boolean(this.lists) && review.length === 0, el => el.child(div().px(14).py(4).text_size(12).text_color(t.dim).child("Nothing to review.")))
          .child(v_flex().px(4).children(review.map(pr => this.row(pr, t, "rv")))))
        .when(!this.lists && !this.error, el => el.child(div().px(14).py(8).text_size(12).text_color(t.dim).child("Loading…"))));
  }
}
