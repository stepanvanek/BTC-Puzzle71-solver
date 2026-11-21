// Entry point. Initialises WebGPU, wires the test runner, and wires the search
// start/stop buttons. Tests run as a silent preflight on Start when the
// (adapter + shader source) fingerprint matches the last successful run; only
// re-validation due to a code/driver change blocks Start with a visible run.

import { initWebGPU, describeWebGPUFailure, browserName, deviceLostInfo, ensureDevice, isDeviceRefusal } from "./webgpu.js";
import { runAllTests, isCompileFailure } from "./tests.js";
import { SearchCoordinator } from "./coordinator.js";
import { PUZZLE_UTXOS } from "./puzzle-utxos.js";
import { enqueue as enqueueClaim, wireAutoDrain, saveRecoveredKey } from "./claim-queue.js";
import { parseShareParams, buildShareURL, isLikelyBitcoinAddress } from "./share.js";
import { TARGET_ADDRESS, RANGE_START, RANGE_END } from "./config.js";

import { testBigintWGSL }    from "./shaders/test_bigint.js";
import { testSha256WGSL }    from "./shaders/test_sha256.js";
import { testRipemd160WGSL } from "./shaders/test_ripemd160.js";
import { testSecp256k1WGSL } from "./shaders/test_secp256k1.js";
import { testPipelineWGSL }  from "./shaders/test_pipeline.js";
import { searchWGSL }        from "./shaders/search.js";

const PREFLIGHT_KEY = "puzzlecrack.preflight";
const PAYOUT_KEY = "puzzlecrack.payout";
const INSTALL_DISMISSED_KEY = "puzzlecrack.installDismissed";
const TAB_NOTICE_DISMISSED_KEY = "puzzlecrack.tabNoticeDismissed";

// Background gaps shorter than this are ordinary tab switching and not worth a
// word. See docs/tab-visibility-notice.md for the measurement behind all of it:
// a five-minute hidden tab produced zero dispatches, so "paused" is literal.
const TAB_PAUSE_MIN_MS = 30_000;
const PAUSED_TITLE = "Paused - Krackpot";

const $ = (id) => document.getElementById(id);
const setGpuInfo = (text) => { $("gpu-info").textContent = text; };

// The #gpu-status panel is shown for TWO different failures and its copy is hardcoded for only
// one of them. Reusing it for a capability failure told @Lokuyow "Your browser can't reach
// WebGPU" while the adapter line directly beneath said nvidia / lovelace / chrome, and then
// advised him to use Chrome on a desktop, which is what he was already on. Wrong panel, wrong
// advice, and it made a real bug report harder to act on rather than easier.
//
// So the story is set explicitly on both paths. Never rely on the markup default: a session can
// hit one failure and then the other, and stale copy is how this happened in the first place.
// Null-safe on purpose. These three ids are NEW, so a cached index.html lacking them paired with
// a fresh main.js would throw a TypeError inside the very failure path that exists to explain the
// failure, turning a diagnosable refusal into a blank panel. Degrading to the markup's built-in
// copy is worse than the right copy and far better than that. Fourth time this session that
// reading tolerantly across a cache boundary has been the difference.
const setGpuStatus = ({ title, lede, help }) => {
  const set = (id, text) => {
    const el = $(id);
    if (el && text !== undefined) el.textContent = text;
  };
  set("gpu-status-title", title);
  set("gpu-status-lede", lede);
  set("gpu-status-help", help);
};

const GPU_STATUS_NO_WEBGPU = {
  title: "Your browser can't reach WebGPU",
  lede: "The search runs on your GPU through WebGPU, and this browser or device can't get to it " +
        "right now. It's not you, and there's often a quick fix.",
  help: "Chrome or Edge on a desktop give the smoothest run. Either way, you can still read how " +
        "Krackpot works while you're here.",
};

// An adapter that WAS returned and then refused requestDevice is not "can't reach WebGPU": the
// browser reached it and found the card. An Intel Xe-LP ran the search for 38 minutes, lost its
// D3D12 device, and after a reload was told its browser could not reach WebGPU, with the footer
// about Chrome 113+ and https. Fourth time a distinct failure has worn copy written for a
// different one. Selected by PHASE (isDeviceRefusal reads the tag initWebGPU puts on the error),
// never by matching the driver's text.
//
// The copy is cause-neutral and platform-neutral ON PURPOSE. With no requiredLimits and no
// requiredFeatures the request cannot fail validation, but it can still be refused for a reset
// driver, a crashed browser GPU process, a stale adapter (Safari reclaims idle devices readily),
// out-of-memory or too many live devices. All share one property, found the card and could not
// open it, and one piece of advice, restart the browser. Naming Windows or a driver reset as THE
// cause would be wrong on macOS and Linux and wrong for half that list. "Quit" rather than "close
// every window", because on macOS closing windows does not quit.
const GPU_STATUS_DEVICE_REFUSED = {
  title: "Your GPU was found, but the browser couldn't open it",
  lede:
    "WebGPU is working and your graphics card was detected. When the browser asked for a device " +
    "on it, the request was refused. That happens after the graphics driver has been reset or the " +
    "browser's own GPU process has crashed, and the browser can keep hold of the dead device " +
    "until it is restarted.",
  help:
    "Quit the browser completely and open it again. A reload is often not enough. If it still " +
    "fails after that, check for system and graphics driver updates. Please press Copy full " +
    "report and send me what it copies.",
};

// A driver crash is not a maths failure, and the panel used to claim it was. The banner below
// already says "GPU DRIVER CRASHED", so a title reading "your GPU works, but it failed the maths
// check" directly contradicted it. Different cause, different action, so different copy.
const GPU_STATUS_DEVICE_LOST = {
  title: "Your GPU driver crashed during the check",
  lede:
    "WebGPU started and your card was detected, then the driver stopped responding and the " +
    "device was lost. That points at a driver or system fault rather than anything wrong with " +
    "your hardware.",
  help:
    "Reloading often works. So can updating the graphics driver, or closing other GPU-heavy " +
    "apps and trying again.",
};

// A driver that could not BUILD the shader is not a GPU that computed the wrong answer, and the
// maths copy told the first person it happened to exactly that. The Adreno 740 in the first
// production diagnostics report failed test 1 with `CreateComputePipelines failed with
// VK_ERROR_UNKNOWN`: the pipeline never existed, so nothing ran and nothing was computed. Third
// time a distinct failure has worn copy written for a different one, after the no-WebGPU panel
// being reused for a capability failure and the device-lost case claiming broken maths.
//
// The action differs too, which is the real argument for splitting it. A driver update fixes this
// class and cannot fix wrong arithmetic.
const GPU_STATUS_COMPILE_FAILED = {
  title: "Your GPU driver could not build the search code",
  lede:
    "WebGPU started and your card was detected. Your graphics driver then failed to compile one " +
    "of the programs the check needs, so that program never ran and never produced a wrong " +
    "answer. This is a driver problem rather than a sign that your hardware is broken or too slow.",
  help:
    "This happens on some Android and some Windows graphics drivers. Updating the driver is the " +
    "fix that works most often. If it says a test timed out rather than failed, reload and try " +
    "again a couple of times, because some drivers are slow to compile this the first time and " +
    "then keep the result. Please press Copy full report and send me what it copies.",
};

// A GPU that never answered did not answer wrongly, and the catch-all copy told an RTX 4060 owner
// it had failed a maths check when the truth was that a trivial 256-bit add was sent to the card
// and never came back. Reported by @Lokuyow 2026-08-29, with the diagnostics naming the phase as
// mapAsync, which is what made the distinction visible at all.
//
// The browser suggestion is evidence-backed rather than a shrug: on the RX 7800 XT, Brave passed
// after two reloads while Chrome stayed stuck and Firefox got further before stopping. The engines
// use different graphics backends, so the same card genuinely gets different distances.
const GPU_STATUS_TIMED_OUT = {
  title: "Your GPU stopped responding during the check",
  lede:
    "WebGPU started and your card was detected, then one of the checks was sent to your GPU and " +
    "never came back, so the check gave up waiting. Nothing here gave a wrong answer. The answer " +
    "never arrived at all. The search stays locked because a card that stalls on a check this " +
    "small would stall on the real search too.",
  help:
    "Reload and run it again first, because this does not always happen twice. If it keeps " +
    "happening, try a different browser: Chrome, Firefox, Brave and Edge each talk to your " +
    "graphics card differently, and the same card often gets further on one than on another. " +
    "Your card can also stay busy until the browser is closed completely, so close it fully " +
    "before the next try. If none of that helps, please press Copy full report and send me what " +
    "it copies.",
};

// ?diag=1 renders the report on a device that is working perfectly.
//
// WHY IT EXISTS. The collector only ever ran from a failure path, so it had never executed on
// WebKit or Gecko at all: every real report so far has been Chromium, on Windows or Android.
// Safari has no userAgentData, no getHighEntropyValues and no deviceMemory, and its Cache API
// throws in Private Browsing. Those are exactly the branches written defensively and never met by
// a real browser. The structural problem is that a report only exists when a device FAILS, while
// the devices worth verifying on are the ones that pass.
//
// It also lets anyone contribute a full hardware report without having to fail first: adapter
// limits, features, core counts and the multi-GPU flag are all things the rate table has had to
// infer by arithmetic until now.
const GPU_STATUS_DIAGNOSTIC = {
  title: "Diagnostics",
  lede:
    "Nothing is wrong. You asked for this report, so it describes your browser, your machine and " +
    "your graphics card. None of it is sent anywhere. Copy full report puts it on your clipboard " +
    "and nowhere else.",
  help: "Remove ?diag=1 from the address to go back to the search.",
};

// Adreno gets its own copy, because the generic compile story above gives it three pieces of
// advice that are all now known to be false for it. "Updating the driver is the fix that works
// most often" is wrong across three devices on two driver lines; "reload and try again" is wrong
// because the failure is deterministic across four reports and three of our builds; and the
// neighbouring timeout copy's "try a different browser" is wrong because Android is Chromium-only
// in practice. Every flag combination has been tried too (#enable-unsafe-webgpu widened the
// feature set, #enable-vulkan flipped Chrome's Vulkan line) and neither changed a thing.
//
// So the honest thing is to stop these users spending time on fixes that cannot work. It says
// "how the browser builds GPU code" rather than "browser bug" ON PURPOSE: three drivers and two
// GPU generations point at Dawn, but a Qualcomm driver bug that Dawn trips over fits the evidence
// equally well, and we do not know which. Naming where it fails is checkable from the error;
// naming whose fault it is would not be.
const GPU_STATUS_ADRENO = {
  title: "Android phones can't run this yet",
  lede:
    "WebGPU started and your GPU was detected, then the browser could not build the search code " +
    "for it. Nothing was computed, so nothing gave a wrong answer. Every Qualcomm Adreno phone " +
    "reported so far fails at exactly this point, which makes it a known problem rather than " +
    "something particular to your phone.",
  help:
    "It's a known problem in how the browser builds GPU code, and nothing you change on your " +
    "phone will fix it. Driver updates, reloading and browser flags have all been tried on the " +
    "affected phones and none of them helped, so please don't spend time on those. A desktop or " +
    "laptop will work. If you'd like to help me chase it, press Copy full report and send me " +
    "what it copies.",
};

// Both places initWebGPU can fail in front of the user (page init, and re-acquiring on Start)
// render the same way, so the choice of story lives in one function. The Linux/Vulkan hint from
// describeWebGPUFailure is for a MISSING adapter; telling someone whose adapter was found to go
// enable Vulkan is the same class of wrong advice as the Adreno driver-update line, so the refusal
// story shows the bare error instead.
const showInitFailure = (e) => {
  const refused = isDeviceRefusal(e);
  setGpuStatus(refused ? GPU_STATUS_DEVICE_REFUSED : GPU_STATUS_NO_WEBGPU);
  $("gpu-status").hidden = false;
  setGpuInfo(refused ? `FAILED: ${e.message}` : describeWebGPUFailure(e.message));
};

const GPU_STATUS_CHECK_FAILED = {
  title: "Your GPU works, but it failed the maths check",
  lede:
    "WebGPU started fine and your card was detected, so this is not a browser or hardware " +
    "support problem. One of the correctness checks did not give the answer it should, and the " +
    "search stays locked because a GPU that computes the wrong answer would burn electricity " +
    "forever without ever finding anything.",
  // Reloading is real advice here, not a shrug. Some drivers need longer than our budget to
  // compile this shader the first time, and because a WebGPU compile cannot be cancelled the
  // driver finishes and caches it anyway, so the next attempt gets further. One reporter's card
  // passed on the third try for exactly this reason.
  help:
    "If this says a test timed out, try reloading and running it again, up to a couple of times. " +
    "Some graphics drivers are slow to compile this shader the first time and then keep the " +
    "result, so a second or third attempt often gets through. This is more likely my bug than " +
    "yours, so if it keeps failing, please press Copy full report and send me what it copies.",
};
// Fill in the machine half of the refusal panel, and arm the copy button.
//
// WHY IT IS SEPARATE FROM THE PANEL RENDER. The panel must appear immediately: the user is
// looking at a stalled screen and the three failure lines are what they came for. Collecting
// diagnostics probes for a second adapter, which is a WebGPU call on a machine whose GPU has just
// misbehaved. So the panel renders first and this runs after it, adding to a panel that is
// already useful rather than delaying one.
//
// NOTHING HERE MAY THROW. This is the screen that explains a failure; a TypeError inside it
// replaces a diagnosable refusal with a blank card. Every DOM read is null-safe for the same
// reason setGpuStatus is: these ids are new, so a cached index.html paired with a fresh main.js
// must degrade to the panel it already had rather than break it.
const renderDiagnostics = async ({ adapter = null, coordinator: coord = null } = {}) => {
  const box = $("gpu-info");
  const row = $("diag-row");
  const btn = $("copy-diagnostics");
  if (!box || !row || !btn) return;

  let diag, d;
  try {
    // DYNAMIC, and this is the whole reason the module is loaded here rather than at the top.
    // A static import puts diagnostics.js on main.js's module graph, so a diagnostics.js that
    // 404s stops main.js executing AT ALL: measured, and the page then has no Start button, no
    // target address and not even the failure panel this function exists to fill in. The likely
    // trigger is prosaic, a commit that ships main.js without the new file. Same lesson as
    // claim-relay.js on 2026-08-17. The one module that runs only after something has already
    // gone wrong must not be able to be the thing that goes wrong.
    //
    // Still precached in APP_SHELL, so the offline path is unchanged: the service worker serves
    // this from cache rather than reaching the network at the moment of failure.
    diag = await import("./diagnostics.js");
    // The panel text goes in as context so one paste carries the failed test AND the machine. A
    // system profile that does not say what failed is a worse report than the screenshot it replaces.
    //
    // The TITLE goes in too, because it names which of the three stories the user was actually
    // shown, and that is the part most likely to be iterated on. A report saying only what failed
    // cannot say whether the explanation offered for it was the right one. Read null-safely: on a
    // cached index.html lacking the id this simply contributes nothing.
    const shown = $("gpu-status-title")?.textContent?.trim();
    d = await diag.collectDiagnostics({
      adapter,
      coordinator: coord,
      context: [shown && `Panel: ${shown}`, box.textContent].filter(Boolean).join("\n"),
    });
  } catch { return; }

  try {
    const { system, flags } = diag.summariseDiagnostics(d);
    // Two lines at most on the panel itself, because this is what gets screenshotted and the
    // report that started all this arrived as a screenshot. Everything else is behind the button.
    const lines = [];
    if (system) lines.push(`System: ${system}`);
    // A software adapter or a second GPU explains a whole class of report outright, so neither is
    // allowed to hide behind a button.
    for (const f of flags) lines.push(`NOTE: ${f}`);
    if (lines.length) box.textContent += `\n${lines.join("\n")}`;

    const report = diag.formatDiagnostics(d);
    const feedback = $("diag-feedback");
    const say = (msg) => { if (feedback) feedback.textContent = msg; };
    // onclick, not addEventListener: a manual re-check runs this path again, and a second listener
    // would copy twice and report twice.
    btn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(report);
        say("Copied. Please paste it to me.");
      } catch {
        // Refused clipboard (Safari outside a gesture, or a non-secure context). Show the text and
        // select it so the keyboard shortcut still works, rather than leaving a dead button.
        const ta = $("diag-report");
        if (!ta) { say("Copy failed."); return; }
        ta.value = report;
        ta.hidden = false;
        ta.focus();
        ta.select();
        say("Copy blocked. Press Ctrl/Cmd+C.");
      }
    };
    row.hidden = false;
  } catch { /* the panel keeps whatever it already had, which is the three lines that matter */ }
};

// Deliberately NOT in share.js. That module builds share links and validates values that reach the
// DOM; this is a debug switch that must never become part of a shared URL. Strict equality with
// "1", so anything else is simply not the flag, and wrapped because a malformed URL can throw.
const diagRequested = () => {
  try { return new URLSearchParams(location.search).get("diag") === "1"; }
  catch { return false; }
};

// Copy a hardware report from a RUNNING search, so it carries keys/sec.
//
// WHY THIS IS NOT THE ?diag=1 PANEL. That path renders at init, before Start, so `coordinator` is
// still null and the report has no SEARCH section: it produces everything except the one field the
// rate table exists for. The obvious fix, re-rendering the panel after a run, is worse than the
// bug. Showing #gpu-status triggers `.pane-right:has(> #gpu-status:not([hidden]))`, which sets
// display:none on every sibling in the console, so the user would lose the Stop button and the
// telemetry while the search kept running. Measured, not theorised.
//
// So the control lives on the telemetry panel and only ever READS state. It cannot affect the
// search, and on a device that never starts one it is simply never revealed.
const wireReportButton = () => {
  const row = $("report-row");
  const btn = $("copy-report");
  if (!row || !btn) return;                 // cached index.html without the ids: degrade silently

  btn.onclick = async () => {               // onclick, so a second Start cannot stack handlers
    const say = (m) => { const el = $("report-feedback"); if (el) el.textContent = m; };
    // Same message, with the handle as a real link. Built with createElement rather than
    // innerHTML: the string is a hardcoded literal so there is nothing to inject, but this file
    // assigns text through textContent everywhere else and an innerHTML here would be the one
    // exception a future edit could interpolate into.
    //
    // target="_blank" IS NOT DECORATION HERE. This message only ever appears during a running
    // search, so a same-tab navigation would destroy the search the user just ran to produce the
    // report. rel matches the footer's existing external-link convention.
    const sayLinked = (before, after) => {
      const el = $("report-feedback");
      if (!el) return;
      const a = document.createElement("a");
      a.href = "https://x.com/simonmales";
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "@simonmales";
      el.replaceChildren(before, a, after);
    };
    let report;
    try {
      const diag = await import("./diagnostics.js");
      const d = await diag.collectDiagnostics({
        adapter: adapterRef,
        coordinator,
        context: `Report: running search\nGPU: ${$("m-gpu")?.textContent || "unknown"}`,
      });
      report = diag.formatDiagnostics(d);
    } catch {
      say("Could not build the report.");
      return;
    }
    try {
      await navigator.clipboard.writeText(report);
      // "I'M BUILDING", present tense, and no promise that their card appears. Two earlier drafts
      // failed on exactly that. "This is how the GPU table gets built" points at something the
      // visitor has never seen, since the 43-row dataset is in CLAUDE.md and the repo is closed,
      // and the only public table is four curated rows in the blog post. "I'll add your card" was
      // worse, promising a visible outcome that cannot happen. The present tense is the honest
      // version: it gives a reason to bother without claiming a result. Once the measured-rates
      // page ships, "and I'll add your card" becomes true and verifiable, and can go back in.
      sayLinked("Copied. Send it to ", " on X/Twitter please, I'm building a table of GPUs.");
    } catch {
      const ta = $("report-text");
      if (!ta) { say("Copy failed."); return; }
      ta.value = report;
      ta.hidden = false;
      ta.focus();
      ta.select();
      say("Copy blocked. Press Ctrl/Cmd+C.");
    }
  };
};

// Revealed on the first dispatch that produces a rate, and never hidden again for the session.
// Before that the report would say "unavailable" for the only field worth collecting.
let reportRowShown = false;
const revealReportRow = (rate) => {
  if (reportRowShown || rate === null || rate === undefined) return;
  const row = $("report-row");
  if (!row) return;
  row.hidden = false;
  reportRowShown = true;
};

const setBanner = (text, fail = false) => {
  const el = $("result-banner");
  el.hidden = false;
  el.classList.toggle("fail", fail);
  el.textContent = text;
};
const fmt = (n) => n.toLocaleString();
const fmtBig = (n) => Number(n).toLocaleString();

// Console calling card. The repo is closed, so the audit surface is the
// unminified source shipped to the browser. Anyone who opens devtools gets
// pointed straight at it. (Console styling ignores page @font-face, so the
// brand line falls back to a condensed sans; size and colour still land.)
(() => {
  const brand = "font:800 46px/1.1 'Anton','Arial Narrow',sans-serif;color:#db3b26;letter-spacing:1px";
  // Group the card under the KRACKPOT header so it reads as one block, indented
  // and set apart from the normal-weight runtime logs. Body lines keep the
  // console's default colour (theme-safe) but go bold.
  const note = "font-weight:bold";
  console.group("%cKRACKPOT", brand);
  console.log("%cUnminified on purpose. No build step, no bundler: what you read here is what runs.", note);
  console.log("%cStart at src/main.js. The search kernel (secp256k1, SHA-256, RIPEMD-160) is src/shaders/search.js.", note);
  console.log("%cHow it works: https://krackpot.io/blog/how-it-works", note);
  console.groupEnd();
})();

// Rebuild the always-visible, copy-ready share link from the current form
// state. buildShareURL omits an invalid/empty `pay` on its own, so a partial
// address just yields a link without the pay param rather than a broken one.
const refreshShareURL = () => {
  const field = $("share-url");
  if (!field) return;
  const pay = $("user-payout-address").value.trim();
  field.value = buildShareURL({
    pay: pay || undefined,
    autostart: $("share-autostart").checked,
  });
};

// Surface which cached build is live. The service-worker cache name embeds
// sw.js's VERSION (`puzzlecrack-<VERSION>`) and `activate` deletes all others,
// so reading it back tells you at a glance whether a device is on the latest
// deploy — useful when a test device is serving a stale cache.
const showBuildVersion = async () => {
  const el = $("build-version");
  if (!el || !("caches" in window)) return;
  try {
    const keys = await caches.keys();
    const c = keys.find((k) => k.startsWith("puzzlecrack-"));
    if (c) el.textContent = `build ${c.replace("puzzlecrack-", "")}`;
  } catch { /* Cache API unavailable — leave blank */ }
};

// Median time to find the key at the current rate, in human-readable units.
//
// ln(2), NOT one half. Half a full sweep is the median for a search that never revisits a key: a
// shuffle of all N keys scanned once, or a cyclic sweep from a random start. This search is
// neither. Every dispatch picks a fresh CSPRNG start and nothing is remembered between them, so it
// samples WITH REPLACEMENT forever, hits are geometric rather than uniform, and the median is
// N*ln(2). That is 1.386x longer than what this used to display, which made every ETA on the site
// optimistic in the one direction a project selling odds-honesty cannot afford.
//
// The label matters as much as the number. "random search" reads as a shuffle to anyone who knows
// the distinction, and a shuffle is exactly the search for which N/2 would have been right.
// Derivation, Monte Carlo and the objections that were checked: docs/eta-median-correction.md.
const formatEta = (rangeBig, rate) => {
  if (rate <= 0) return "—";
  const fullSec = Number(rangeBig) / rate;
  if (!isFinite(fullSec)) return "—";
  return `${prettyDuration(fullSec * Math.LN2)} (random sampling with replacement)`;
};

// Word-scale names for the enormous year counts this workload produces.
const YEAR_SCALES = [
  [1e24, "septillion"], [1e21, "sextillion"], [1e18, "quintillion"],
  [1e15, "quadrillion"], [1e12, "trillion"], [1e9, "billion"],
  [1e6, "million"], [1e3, "thousand"],
];

const prettyDuration = (sec) => {
  if (sec < 60) return `${sec.toFixed(1)} s`;
  if (sec < 3600) return `${(sec / 60).toFixed(1)} min`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)} h`;
  const days = sec / 86400;
  if (days < 365) return `${days.toFixed(1)} days`;
  const years = days / 365.25;
  if (years < 1000) return `${Math.round(years).toLocaleString()} years`;
  for (const [v, name] of YEAR_SCALES) {
    if (years >= v) {
      const q = years / v;
      return `${q < 10 ? q.toFixed(1) : Math.round(q).toLocaleString()} ${name} years`;
    }
  }
  return `${Math.round(years).toLocaleString()} years`;
};

// Ladder-short ETA for the odds race ("~360K yrs", "~4 months", "~3 days"),
// distinct from formatEta above, which returns the long telemetry string.
const formatEtaLadder = (rangeBig, rate) => {
  if (!rate || rate <= 0) return "—";
  const medianSec = (Number(rangeBig) / rate) * Math.LN2;
  if (!isFinite(medianSec) || medianSec <= 0) return "—";
  const days = medianSec / 86400;
  if (days < 1)   return `~${Math.max(1, Math.round(medianSec / 3600))} h`;
  if (days < 60)  return `~${Math.round(days)} days`;
  const months = days / 30.44;
  if (months < 22) return `~${Math.round(months)} months`;
  const years = days / 365.25;
  if (years < 1000) return `~${Math.round(years)} yrs`;
  for (const [v, u] of [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]]) {
    if (years >= v) { const q = years / v; return `~${q < 10 ? q.toFixed(1) : Math.round(q)}${u} yrs`; }
  }
  return `~${Math.round(years)} yrs`;
};

// The live "This device" rung in the odds ladder (design handoff
// design_handoff_odds_ladder_live_rung). Created on the first search start,
// updated each dispatch, frozen grey on stop, re-keyed and re-sorted among the
// static rungs by ETA. It is display only; nothing here touches the search.
const liveRung = (() => {
  const raceEl = () => document.querySelector("#odds .race");
  // The static widths are ~log scale: about 10.2% of track per tenfold in years.
  const widthPct = (years) => 22 + (Math.log10(years) + 2.086) * 10.2;
  const compact = (r) =>
    r >= 1e9 ? (r / 1e9).toFixed(1) + "B" :
    r >= 1e6 ? (r / 1e6).toFixed(1) + "M" :
    r >= 1e3 ? (r / 1e3).toFixed(1) + "K" : String(Math.round(r));

  const ensure = () => {
    let row = $("race-live");
    if (!row) {
      const race = raceEl();
      if (!race) return null;
      row = document.createElement("div");
      row.className = "race-row race-live";
      row.id = "race-live";
      row.innerHTML =
        '<span class="race-label"><span class="race-live-name">This device</span>' +
        '<span class="race-live-sub" id="race-live-sub">—</span></span>' +
        '<div class="race-track"><div class="race-fill race-fill-live" id="race-live-fill"></div></div>' +
        '<span class="race-val" id="race-live-val">—</span>';
      race.appendChild(row);
      // One-shot: let race-in play once, then drop the class so a later re-sort
      // (which moves the node) cannot restart the entrance animation.
      row.classList.add("race-live-enter");
      setTimeout(() => row.classList.remove("race-live-enter"), 450);
    }
    return row;
  };

  // Recompute every rung's width from its data-years, normalised so the longest
  // of {live, 3070} is 100%, then place the live row by ETA (longest at the top).
  const rescale = (liveYears) => {
    const race = raceEl();
    if (!race) return;
    const fills = [...race.querySelectorAll(".race-fill")];
    const ws = fills.map((f) => {
      const y = parseFloat(f.dataset.years);
      return isFinite(y) && y > 0 ? widthPct(y) : 0;
    });
    const maxW = Math.max(0, ...ws);
    fills.forEach((f, i) => { f.style.width = (maxW > 0 ? ws[i] / maxW * 100 : 100).toFixed(1) + "%"; });
    const live = $("race-live");
    // Target slot, with a 3% deadband: a device whose ETA is within 3% of a rung
    // (notably a ~3070 sitting on the reference row's own boundary) counts as tied
    // and keeps its current side, so 5-second rate wobble can't flip the order 4x/s.
    let before = null;
    for (const r of race.querySelectorAll(".race-row")) {
      if (r === live) continue;
      const y = parseFloat(r.querySelector(".race-fill")?.dataset.years);
      if (!isFinite(y)) continue;
      if (liveYears > y * 1.03) { before = r; break; }        // clearly slower → above r
      if (liveYears >= y * 0.97) {                             // tie → hold current side
        const liveAbove = (live.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
        if (liveAbove) { before = r; break; }
      }                                                        // clearly faster → below r
    }
    // Move only when the slot truly changes: rescale() runs ~4x/s, and an
    // unconditional insert re-adds the node every frame.
    if (live.nextElementSibling !== before) {
      if (before) race.insertBefore(live, before); else race.appendChild(live);
    }
  };

  const update = ({ rate, rangeBig }) => {
    // Wait for a real rate before the row exists: creating it on the first (rate
    // null) dispatch would show a full-width unsorted bar for one frame.
    if (rate == null) return;
    const row = ensure();
    if (!row) return;
    row.classList.remove("is-paused");
    row.querySelector(".race-live-name").textContent = "This device";
    const gpuBrowser = $("m-gpu")?.textContent || "unknown";
    $("race-live-sub").textContent = `${gpuBrowser} · ${compact(rate)} keys/s`;
    $("race-live-val").textContent = formatEtaLadder(rangeBig, rate);
    const years = (Number(rangeBig) / rate * Math.LN2) / (86400 * 365.25);
    $("race-live-fill").dataset.years = String(years);
    rescale(years);
  };

  const resume = () => {
    const row = $("race-live");
    if (!row) return;
    row.classList.remove("is-paused");
    row.querySelector(".race-live-name").textContent = "This device";
    // Clear the paused sub/val so the dark animated bar isn't contradicted by
    // "… checked" text until the first dispatch of the resumed run lands.
    const gpuBrowser = $("m-gpu")?.textContent || "unknown";
    $("race-live-sub").textContent = `${gpuBrowser} · resuming…`;
    $("race-live-val").textContent = "—";
  };

  const pause = () => {
    const row = $("race-live");
    if (!row) return;
    row.classList.add("is-paused");
    row.querySelector(".race-live-name").textContent = "This device · paused";
    // Identity only: the running keys/s would read as still-live, and the checked
    // total is a long comma number that overflows the label column.
    $("race-live-sub").textContent = $("m-gpu")?.textContent || "unknown";
  };

  return { update, resume, pause };
})();

// Hash (adapter identity, shader sources) into a stable fingerprint. A match
// against the stored value means the math hasn't changed and previously-passed
// tests are still valid — safe to skip the preflight.
const computeFingerprint = async (adapter) => {
  const info = adapter.info || {};
  const allShaders = [
    testBigintWGSL, testSha256WGSL, testRipemd160WGSL,
    testSecp256k1WGSL, testPipelineWGSL, searchWGSL,
  ].join("\n---\n");
  const text = JSON.stringify({
    vendor: info.vendor || "",
    architecture: info.architecture || "",
    device: info.device || "",
    description: info.description || "",
  }) + "\n" + allShaders;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
};

// Bumped when the SET of blocking tests changes in a way a stored pass should not survive.
// The fingerprint hashes adapter.info and the WGSL sources but NOT the test manifest, so
// without this a newly added blocking test would be silently skipped by every existing
// stored pass — the gate would quietly stop enforcing the thing it was just taught to check.
// v2: blocking/diagnostic split, and diagnostics dropped from the automatic preflight.
// v3: four blocking SEARCH smoke tests added for the affine batch kernel (centre, plus side,
// slice edge, second batch). The WGSL change already invalidates every fingerprint, so this
// is the manifest contract being kept rather than a re-run being forced.
const GATE_VERSION = 3;

const getStoredPreflight = () => {
  try { return JSON.parse(localStorage.getItem(PREFLIGHT_KEY) || "null"); }
  catch { return null; }
};

const setStoredPreflight = (fingerprint) => {
  localStorage.setItem(PREFLIGHT_KEY, JSON.stringify({
    fingerprint,
    gateVersion: GATE_VERSION,
    passedAt: new Date().toISOString(),
  }));
};

// A stored pass counts only if it was produced by the same shaders AND the same gate rules.
// Note the deliberate asymmetry: this version went UP, but the blocking set only SHRANK, so
// every device that passed under v1 would also pass under v2. Re-running them would be
// pointless churn on ~40 working devices, so a missing gateVersion is treated as acceptable
// rather than stale. Bump-and-reject is for future changes that ADD blocking coverage.
const preflightIsValid = (stored, fingerprint) =>
  !!stored && stored.fingerprint === fingerprint
  && (stored.gateVersion === undefined || stored.gateVersion <= GATE_VERSION);

let adapterRef = null;
let coordinator = null;

// Install-to-home-screen: we suppress the browser's own (aggressive) default
// prompt and stash the event, then surface our own in-app CTA only after the
// user has actually used the app (valid payout + search started). `null` until
// the browser fires beforeinstallprompt; nulled again once used or installed.
let deferredInstallPrompt = null;

// The install CTA is deliberately delayed past the FIRST search start — showing
// it the instant cracking begins is too abrupt. The first successful start
// (valid payout) only "arms" it; it then surfaces on the next natural beat:
// either when the user navigates back to the tab, or on a second successful
// start. `true` once armed.
let installCtaArmed = false;

// Reveal the in-app install CTA — but only if the browser has offered a prompt,
// the user hasn't already dismissed it, and the app isn't already installed
// (running standalone). Called after a real search start, never on page load.
const maybeShowInstallCTA = () => {
  const cta = $("install-cta");
  if (!cta || !deferredInstallPrompt) return;
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
  if (standalone) return;
  try { if (localStorage.getItem(INSTALL_DISMISSED_KEY)) return; } catch { /* storage off — show it */ }
  cta.hidden = false;
};

// Once the CTA is armed on the first start, reveal it the next time the user
// returns to the tab. Self-removing: it only needs to fire once.
const onVisibleShowInstallCTA = () => {
  if (document.visibilityState !== "visible") return;
  document.removeEventListener("visibilitychange", onVisibleShowInstallCTA);
  maybeShowInstallCTA();
};

// Wire the beforeinstallprompt capture + the CTA's own buttons. Registered once
// at startup; the CTA itself stays hidden until maybeShowInstallCTA() reveals it.
const wireInstallPrompt = () => {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();            // suppress the browser's default install banner
    deferredInstallPrompt = e;     // stash it for our own CTA button
  });
  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    const cta = $("install-cta");
    if (cta) cta.hidden = true;
  });

  const cta = $("install-cta");
  const installBtn = $("install-app");
  const dismissBtn = $("install-dismiss");
  if (!cta || !installBtn || !dismissBtn) return;

  installBtn.addEventListener("click", async () => {
    if (!deferredInstallPrompt) { cta.hidden = true; return; }
    const prompt = deferredInstallPrompt;
    deferredInstallPrompt = null;  // a prompt event can only be used once
    cta.hidden = true;
    try { await prompt.prompt(); } catch { /* user dismissed the native prompt */ }
  });

  dismissBtn.addEventListener("click", () => {
    cta.hidden = true;
    try { localStorage.setItem(INSTALL_DISMISSED_KEY, "1"); } catch { /* storage off — dismissal just isn't remembered */ }
  });
};

// On a verified hit: build the tx variants and submit PRIVATELY (three tiers),
// never to the public mempool (that exposes the pubkey and gets it front-run).
// Always surface the privkey + signed hex first so the finder can recover by
// hand. Orchestration lives in claim-orchestrator.js; see docs/claim-privacy.md.
const runClaim = async ({ priv, hex, addr, userPayoutAddress }) => {
  // FIRST, before anything that can fail: log and persist the key. Every path
  // below (missing snapshot, build error, offline, submit failure) can lose the
  // tx and still be recovered from the key alone, so the key must outlive them.
  console.log("private key (hex): 0x" + hex);
  const keySaved = saveRecoveredKey({ privHex: hex, address: addr });
  const keyNote = keySaved
    ? `The key is saved in this browser (localStorage "puzzlecrack.recoveredKeys") — copy it somewhere safe now.`
    : `WARNING: could not save the key to this browser. COPY IT NOW, it exists nowhere else.`;

  // Shared by the TWO paths that hand the finder a key and no transaction: a missing
  // UTXO snapshot, and a claim build that failed. That is the most dangerous state this
  // app can produce, because the obvious way to spend a recovered puzzle key is the way
  // that loses it. A puzzle key sits in a narrow range, so any public broadcast reveals
  // a pubkey that falls to Pollard's kangaroo in minutes; that is how 66 and 69 were
  // taken. Defined once so the two banners cannot drift apart.
  const manualClaimWarning =
    `You have to build and sign the spend yourself. Never share this private key with ` +
    `anyone and never paste it into a website. Once you have a signed transaction, submit ` +
    `THAT privately via slipstream.mara.com. Do NOT send it to a public explorer, a public ` +
    `node, or any online service that broadcasts, or it will be front-run and stolen ` +
    `before it confirms.`;

  const utxos = (PUZZLE_UTXOS.addresses && PUZZLE_UTXOS.addresses[addr]) || [];
  if (utxos.length === 0) {
    setBanner(
      `HIT! priv=0x${hex} for ${addr}, but no UTXO snapshot was captured for this ` +
      `address. ${manualClaimWarning} ${keyNote}`, true);
    return;
  }

  // Decide where the 6 BTC user output goes. Valid payout address -> pay it;
  // otherwise fall back to the developer address rather than risk the prize
  // vanishing. A hit is a once-in-the-universe event; never let the key slip.
  const fellBackToDev = !isLikelyBitcoinAddress(userPayoutAddress);

  let result;
  try {
    // Deadlined for the same reason the gift-wrap is, and it matters more here.
    // prize-claim.js statically imports @scure/btc-signer from esm.sh, so this line
    // is where that fetch happens, and it sits BEFORE any tier has run. A network
    // that drops packets rather than refusing them leaves an import pending, not
    // rejected, so without this the hit path could hang here indefinitely: nothing
    // submitted, no banner, and a finder staring at an idle page. With it, the
    // failure becomes the manual-claim banner below, which carries the key and the
    // do-not-broadcast warning. Generous, because this is the prize path.
    const CLAIM_IMPORT_DEADLINE_MS = 20000;
    const [{ orchestrateClaim }, { DEV_ADDRESS }] = await Promise.race([
      Promise.all([
        import("./claim-orchestrator.js"),
        import("./prize-claim.js"),
      ]),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(
          `claim libraries did not load after ${CLAIM_IMPORT_DEADLINE_MS / 1000}s`)),
        CLAIM_IMPORT_DEADLINE_MS)),
    ]);
    const destination = fellBackToDev ? DEV_ADDRESS : userPayoutAddress;
    result = await orchestrateClaim({
      priv, privHex: hex, addr, destination, fellBackToDev, utxos,
      online: navigator.onLine,
    });
  } catch (e) {
    // This catch had no anti-front-running warning, which made it the most dangerous
    // banner in the app: it hands over a key with no transaction and no guidance.
    //
    // It is also the likeliest shape of a hit years from now. prize-claim.js pulls
    // @scure/btc-signer from esm.sh and is only imported on a hit, so if that CDN is
    // gone the tx cannot be built at all and none of the three tiers can run. The key
    // still survives, because it is saved above before anything here can fail.
    //
    // Deliberately says "did not produce a usable signed transaction" rather than "no
    // transaction was built". This catch is broader than the failed-import case: it also
    // covers a throw from orchestrateClaim, which can happen after the standard variant
    // has been built (buildClaimPayload is not inside its own try). Claiming nothing was
    // built could talk a finder out of a signed tx that does exist, so the wording
    // states only what is certain, that nothing usable reached this banner.
    setBanner(
      `HIT! priv=0x${hex} for ${addr}, but the automatic claim pipeline failed: ` +
      `${e.message}. It did not produce a usable signed transaction, so the prize is ` +
      `claimable from this key alone. ${manualClaimWarning} ${keyNote}`, true);
    console.error("claim build failed:", e);
    return;
  }

  const { variants, tier1, relay, queued, queueEntry, destination } = result;

  // Surface the signed hexes too (the key was logged + persisted on entry).
  console.log("standard tx:", variants.standard.txid, variants.standard.hex);
  if (variants.shield) console.log("shield tx:", variants.shield.txid, variants.shield.hex);

  const payoutLine = fellBackToDev
    ? `No payout address was set — the prize goes to the developer (${destination}).`
    : `${variants.standard.userAmount.toLocaleString()} sats → ${destination}.`;

  // Offline: persist the queue entry; the auto-drain relays it on reconnect.
  if (queued && queueEntry) {
    enqueueClaim(queueEntry);
    setBanner(
      `HIT! priv=0x${hex}. TX built and signed but you're OFFLINE — queued to relay to the ` +
      `developer when connectivity returns. Once you are back online you can also submit it ` +
      `yourself PRIVATELY via slipstream.mara.com. Do NOT paste this into a public explorer ` +
      `or node. ${keyNote}\n\nStandard tx hex (also saved in this browser):\n\n${variants.standard.hex}`, true);
    return;
  }

  // Three outcomes, not two. relay.attempted is false only when the gift-wrap itself
  // could not be built (nostr-tools is fetched on demand and the fetch can fail), and
  // that must not read as a failed claim: it is the developer's backup copy, and
  // whether a pool accepted the tx is reported separately below.
  const relayNote = relay.anyAccepted
    ? "backup copy relayed to the developer"
    : relay.attempted
      ? "developer relay did not confirm"
      : "the developer's backup copy could not be built, which does not affect this claim";

  // Which private pools took it. tier1.ok is "at least one", so name them.
  const pools = tier1.attempted
    ? [tier1.shield?.ok ? `Rebar Shield (${tier1.shield.txid})` : null,
       tier1.slipstream?.ok ? `MARA Slipstream (${tier1.slipstream.txid})` : null].filter(Boolean)
    : [];

  if (tier1.ok) {
    // Tier 1 succeeded: submitted privately via Rebar Shield. Still surface the
    // Slipstream-ready standard hex — Shield accepting a tx does not mean a pool
    // ever mines it (a dry run sat unconfirmed for 64 blocks after an accepted
    // submission, docs/claim-testing.md), and without the hex on screen the user
    // has no way to act on that.
    setBanner(
      `🎉 HIT! Submitted privately to ${pools.join(" and ")}; ${relayNote}. ${payoutLine}\n\n` +
      `priv=0x${hex}\n${keyNote}\n\n` +
      `If it has not confirmed within a few hours, submit it yourself PRIVATELY via ` +
      `slipstream.mara.com — do NOT paste it into a public explorer or node, or it will be ` +
      `front-run and stolen. Standard tx hex:\n\n${variants.standard.hex}`);
  } else {
    // Tier 3: automatic path did not confirm — instruct manual private submission.
    setBanner(
      `HIT! priv=0x${hex}. Automatic private submission did not confirm ` +
      `(${tier1.error || tier1.reason || "unknown"}); ${relayNote}. SUBMIT IT YOURSELF ` +
      `PRIVATELY via slipstream.mara.com — do NOT paste it into a public explorer or node, ` +
      `or it will be front-run and stolen. ${keyNote}\n\n` +
      `Standard tx hex:\n\n${variants.standard.hex}`, true);
  }

  try {
    alert(
      `Bitcoin Puzzle solved!\n\n` +
      `Private key (hex):\n0x${hex}\n\n` +
      `Standard tx: ${variants.standard.txid}\n` +
      // Name the pool(s) that actually took it. Hardcoding "Rebar Shield" here was
      // wrong once Slipstream became a parallel tier: either pool alone satisfies
      // tier1.ok, so a Slipstream-only success used to be announced as a Shield one.
      (tier1.ok
        ? `Submitted privately to ${pools.join(" and ")}\n` +
          `If it does not confirm, submit the standard tx hex (on the page) via ` +
          `slipstream.mara.com, never a public explorer\n`
        : `NOT auto-submitted — submit via slipstream.mara.com, never a public explorer\n`) +
      `Your payout: ${variants.standard.userAmount.toLocaleString()} sats`);
  } catch {}
};

// Run the capability check (WGSL self-tests). The #tests section stays hidden
// while the run is in progress; it's only revealed if something fails. The
// Start button label is repurposed as the visible "we're working" indicator.
// Returns true on full pass.
//
// `includeDiagnostics` controls whether the off-path checks run at all. The automatic
// preflight leaves them OUT: they cannot affect a search, and on an RX 7800 XT one of them
// burns the full 25 s timeout and may leave the driver unhappy, so running them only to
// ignore the result is the worst of both. The manual "Run tests" button passes true, which
// keeps them available for exactly the driver-bug diagnosis they are good at.
const runCapabilityCheck = async ({ includeDiagnostics = false } = {}) => {
  const section = $("tests");
  // The progress bar now sits next to the (disabled) Start button; while the
  // check runs we show only that. The #tests detail panel (heading + results
  // table) stays hidden and is revealed only on failure or cancel.
  $("result-banner").hidden = true;   // clear any prior cancelled/failed banner from an earlier run
  $("tests-blurb").hidden = true;
  $("test-results").hidden = true;
  $("run-tests").hidden = true;
  section.hidden = true;
  $("tests-progress").hidden = false;

  // Let the user abort a bogged-down check and regain control of their system.
  const abort = new AbortController();
  const cancelBtn = $("cancel-tests");
  cancelBtn.hidden = false;
  cancelBtn.disabled = false;
  const onCancel = () => { cancelBtn.disabled = true; abort.abort(); };
  cancelBtn.addEventListener("click", onCancel);

  const startBtn = $("start-search");
  const prevLabel = startBtn.textContent;
  startBtn.disabled = true;
  startBtn.textContent = "Checking capability of your processor…";

  // Get a live device BEFORE running anything. A device lost since the last check used to make
  // every test throw, so "Re-check GPU" reported broken hardware when the only thing wrong was
  // that Safari had reclaimed an idle device. Failing here is a genuine "cannot get a GPU" and is
  // reported as such rather than as a maths failure.
  let reacquired = false;
  try {
    const got = await ensureDevice();
    reacquired = got.reacquired;
    if (got.adapter) adapterRef = got.adapter;   // fingerprint must describe the CURRENT adapter
  } catch (e) {
    cancelBtn.removeEventListener("click", onCancel);
    cancelBtn.hidden = true;
    startBtn.textContent = prevLabel;
    $("tests-progress").hidden = true;
    showInitFailure(e);
    // Worth collecting here too, and for a different reason than the maths failure: this panel's
    // advice is platform-specific (enable Vulkan, use https, update the browser), so which OS and
    // which browser is the whole question. adapterRef may still name the adapter that was working
    // a moment ago, which is worth having; it may also be null, which the collector expects.
    void renderDiagnostics({ adapter: adapterRef });
    setBanner(`Could not get a WebGPU device for the capability check: ${e.message}`, true);
    return false;
  }

  let pass = 0, fail = 0, blockingFail = 0, diagnosticFail = 0, aborted = false, lastStarted = null, lastFailure = null;
  // Undefined against a stale cached tests.js, which isCompileFailure reads as "not a compile
  // phase", so an old pair degrades to the copy it already had rather than throwing.
  let lastFailurePhase = null;
  // Defaults false against a stale cached tests.js, so an old pair degrades to the copy it had.
  let lastFailureTimedOut = false;
  try {
    ({ pass, fail, blockingFail, diagnosticFail, aborted, lastStarted, lastFailure, lastFailurePhase, lastFailureTimedOut } =
      await runAllTests(abort.signal, { includeDiagnostics }));
  } finally {
    cancelBtn.removeEventListener("click", onCancel);
    cancelBtn.hidden = true;
    startBtn.textContent = prevLabel;
    $("tests-progress").hidden = true;
  }

  if (aborted) {
    // Cancelled by the user — not a pass, not a hardware failure. Let them retry.
    $("tests-heading").textContent = "Capability check cancelled";
    $("run-tests").hidden = false;
    section.hidden = false;
    setBanner(
      `Capability check cancelled — your system is free. Click "Re-run capability check" ` +
      `when ready; the search stays locked until the check passes.`,
      true
    );
    return false;
  }

  // Tolerate a STALE cached tests.js. A service worker or HTTP cache can serve an older
  // tests.js alongside this main.js, and the older one returns {pass, fail, aborted} with no
  // blockingFail. `undefined === 0` is false, so the gate then REFUSED A DEVICE ON WHICH EVERY
  // TEST HAD PASSED, and reported "Last test started: unknown" because the old runner never set
  // it. Reproduced exactly on Safari: a normal window failed while private browsing passed,
  // because private browsing has no cache to serve a stale module from.
  //
  // Falling back to `fail` is safe in the only direction that matters: it is the STRICTER
  // pre-change rule, so a mixed pair can over-block but never under-block. Second time this
  // session that a mixed old/new module pair has caused a confusing failure, so the rule is
  // worth stating: when a cross-module return shape changes, read it tolerantly.
  const blockingFailures = blockingFail ?? fail;
  if (blockingFail === undefined) {
    console.warn(
      "runAllTests() returned no blockingFail — a stale cached tests.js is being served against " +
      "this main.js. Falling back to the strict all-pass rule. A hard reload should fix it.",
    );
  }
  // Gate on BLOCKING failures only. A diagnostic failure means an off-path shader misbehaved
  // on this driver, which cannot affect a search, so refusing over it locks out working
  // hardware — confirmed on an RX 7800 XT and reproducible in two browsers.
  if (blockingFailures === 0 && pass > 0) {
    const fingerprint = await computeFingerprint(adapterRef);
    setStoredPreflight(fingerprint);
    if (diagnosticFail > 0) {
      // Worth telling them, and worth telling them it is harmless. Silence here would look
      // like we had not noticed; alarm would be wrong, because the production path passed.
      $("tests-blurb").hidden = false;
      $("test-results").hidden = false;
      $("run-tests").hidden = false;
      section.hidden = false;
      $("tests-heading").textContent =
        `Capability check passed (${diagnosticFail} off-path check${diagnosticFail === 1 ? "" : "s"} failed)`;
      setBanner(
        `Capability check PASSED. ${diagnosticFail} off-path diagnostic${diagnosticFail === 1 ? "" : "s"} ` +
        `failed on this driver; the search does not use ${diagnosticFail === 1 ? "it" : "them"}, so it is ` +
        `cleared to run. Details in the test panel.`,
        true
      );
    } else {
      section.hidden = true;   // clean pass — return to the clean state; search proceeds
    }
    // Put the refusal card away on a pass, because nothing else ever does and the footer's
    // "Re-check GPU" makes a fail-then-pass reachable. While that card is shown, the CSS rule
    // `.pane-right:has(> #gpu-status:not([hidden]))` hides EVERY sibling in the console: the Start
    // button, the payout field, the telemetry, the prize-split disclosure and the result banner.
    // So a re-check that passed used to enable a Start button the user could not see, announce it
    // in a banner the user could not read, and leave a card up saying the GPU had failed. Hiding
    // it here is what returns the console. First load is unaffected: it is already hidden.
    $("gpu-status").hidden = true;
    $("start-hint").hidden = true;   // the "enabled once the check passes" hint is now stale
    return true;
  }

  // Blocking failure: surface the section so the user can see which tests failed.
  $("tests-heading").textContent = `Capability check failed (${pass} pass, ${blockingFailures} blocking fail)`;
  $("tests-blurb").hidden = false;
  $("test-results").hidden = false;
  $("run-tests").hidden = false;
  section.hidden = false;
  // Name the adapter in the refusal. Every refusal report so far has cost a round trip to
  // establish which GPU was actually tested, and on hybrid-graphics machines the answer is
  // often the iGPU rather than the card the user has in mind.
  const info = adapterRef?.info || {};
  const adapterLine = info.description
    || [...new Set([info.vendor, info.architecture].filter(Boolean))].join(" · ")
    || "unknown";
  setGpuInfo(
    `GPU: ${adapterLine} · ${browserName() || "unknown browser"}\n` +
    `Failed test: ${lastStarted || (() => { try { return sessionStorage.getItem("puzzlecrack.lastStartedTest") || "none, it failed before any test ran"; } catch { return "unknown"; } })()}\n` +
    // The reason line is the most useful thing on this panel and it used to live only in the
    // results table, which is below the fold. Three reports arrived saying "it timed out" with
    // no way to tell a stuck compile from a stuck dispatch. Now it is the first thing they see.
    `Reason: ${lastFailure || "unknown"}`
  );
  // Three-way, and the order is load bearing. Device loss wins because a lost device can surface
  // as a compile error, and "your driver crashed" is the more urgent of the two true statements.
  // Compile is tested BEFORE timeout on purpose. A timeout that happened while the driver was
  // building the shader is still best described as a slow build, and the reload advice on that
  // copy is the right advice, so it must not be stolen by the generic stall story.
  const compileFailed = isCompileFailure(lastFailurePhase);
  // Narrows the compile story, rather than sitting beside it as a fifth branch: an Adreno failure
  // that is NOT a compile failure (a timeout, a lost device) still gets the story that fits it.
  // Substring on architecture because the reports read "adreno-7xx" and a future part will read
  // "adreno-8xx" or similar; vendor is checked too so a coincidence elsewhere cannot match.
  // Reuses the `info` already read above for the adapter line, rather than redeclaring it. The
  // syntax gate caught that; `node --check` on the .js would not have.
  const isAdreno = /adreno/i.test(String(info.architecture || "")) ||
                   /adreno/i.test(String(info.description || ""));
  setGpuStatus(deviceLostInfo()    ? GPU_STATUS_DEVICE_LOST
             : compileFailed && isAdreno ? GPU_STATUS_ADRENO
             : compileFailed       ? GPU_STATUS_COMPILE_FAILED
             : lastFailureTimedOut ? GPU_STATUS_TIMED_OUT
             : GPU_STATUS_CHECK_FAILED);
  $("gpu-status").hidden = false;
  // Deliberately not awaited. The panel is complete and readable at this point; the diagnostics
  // add to it a moment later, and the banner below must not wait on a GPU probe to be set.
  void renderDiagnostics({ adapter: adapterRef, coordinator });
  // A lost device is a driver crash, not broken maths, and saying so matters: the two need
  // completely different responses from the user. Updating the driver or closing whatever else
  // is hammering the GPU can fix the first and will never fix the second.
  const lost = deviceLostInfo();
  // If we had to re-acquire the device to run at all, say so. A driver that drops devices and
  // then fails the checks is a different story from one that simply computes wrong answers, and
  // the user can act on the first.
  const lostNote = reacquired
    ? ` The previous GPU device had been lost, so a fresh one was acquired for this check.`
    : ``;
  setBanner(
    lost
      ? `GPU DRIVER CRASHED during the capability check on ${adapterLine} (${lost.reason}). ` +
        `This is a driver or system fault rather than broken math. Reloading may work; so may ` +
        `updating the GPU driver or closing other GPU-heavy apps. See test panel.`
      : `Capability check FAILED (${pass} pass, ${blockingFailures} blocking fail) on ${adapterLine}.` +
        lostNote +
        // Same correction as the panel titles, and in the same order. Note this text is currently
        // unreachable: the `.pane-right:has(> #gpu-status:not([hidden]))` rule puts #result-banner
        // at display:none for the whole of a refusal, measured. Fixed anyway, on the bet that the
        // rule changes, and because leaving parallel strings lying is how they drift apart.
        (compileFailed
          ? ` Your graphics driver could not build the search code, so it will not run. See test panel.`
          : lastFailureTimedOut
            ? ` Your GPU stopped responding during the check, so it will not run. See test panel.`
            : ` Math the search depends on is broken here, so it will not run. See test panel.`),
    true
  );
  return false;
};

// Defensive double-check from the Start handler. Cheap when the fingerprint is
// already cached (the auto-run on load will normally have populated it).
const ensurePreflightPassed = async () => {
  const fingerprint = await computeFingerprint(adapterRef);
  const stored = getStoredPreflight();
  if (preflightIsValid(stored, fingerprint)) return true;
  $("tests-heading").textContent = "Checking capability of your processor…";
  return runCapabilityCheck({ includeDiagnostics: false });
};

const wireSearch = () => {
  const startBtn = $("start-search");
  const stopBtn  = $("stop-search");

  const start = async () => {
    const rangeStart = RANGE_START;
    const rangeEnd   = RANGE_END;
    const targetAddress = TARGET_ADDRESS;
    // The payout address is NOT required to search — the GPU loop never uses
    // it. It's only needed to build the claim tx on a (astronomically rare)
    // hit, so we don't block Start on it. The hit handler re-reads the field
    // and, if it's still missing/invalid, pauses to collect one. The recovered
    // key is always logged first, so the prize is never lost.
    $("user-payout-address").removeAttribute("aria-invalid");
    startBtn.disabled = true;
    stopBtn.disabled  = true;     // re-enabled after preflight finishes

    // Preflight: silent if fingerprint matches; visible run otherwise.
    const ok = await ensurePreflightPassed();
    if (!ok) {
      startBtn.disabled = false;
      return;
    }

    if (!coordinator) {
      coordinator = new SearchCoordinator();
      try {
        await coordinator.setup();
      } catch (e) {
        setBanner("Search shader setup failed: " + e.message, true);
        coordinator = null;
        startBtn.disabled = false;
        return;
      }
    }

    stopBtn.disabled = false;
    $("result-banner").hidden = true;
    const idleLabel = startBtn.textContent;
    startBtn.textContent = "Searching…";
    startBtn.classList.add("searching");

    // Successful use: search is running and the user provided a valid payout
    // address. Don't surface the install CTA the instant cracking starts — it
    // reads as too sudden. The first such start arms it (revealed when the user
    // next returns to the tab); a second start reveals it right away.
    if (isLikelyBitcoinAddress($("user-payout-address").value.trim())) {
      if (installCtaArmed) {
        maybeShowInstallCTA();
      } else {
        installCtaArmed = true;
        document.addEventListener("visibilitychange", onVisibleShowInstallCTA);
      }
    }

    const startTs = performance.now();
    liveRung.resume();
    try {
      await coordinator.start({
        rangeStart, rangeEnd, targetAddress,
        onProgress: ({ totalChecked, rate, dispatchKeys, chunkPriv, chunkSpan }) => {
          // rate is null until the first dispatch lands in the rolling window.
          $("m-rate").textContent = rate === null ? "—" : fmtBig(Math.floor(rate));
          $("m-total").textContent = fmtBig(totalChecked);
          $("m-range").textContent = "0x" + chunkPriv.toString(16) + "  +" + chunkSpan;
          $("m-eta").textContent = formatEta(rangeEnd - rangeStart, rate);
          liveRung.update({ rate, rangeBig: rangeEnd - rangeStart });
          $("m-dispatch").textContent = fmt(dispatchKeys);
          revealReportRow(rate);
          noteDispatch();
        },
        onHit: async ({ priv, addr, verified }) => {
          if (!verified) {
            setBanner(`Spurious hit reported by GPU but CPU verification failed for priv=0x${priv.toString(16)}; ignoring.`, true);
            return;
          }
          const hex = priv.toString(16).padStart(64, "0");
          // Always log the privkey first, before anything else can fail.
          console.log("=== PRIZE PRIVATE KEY (save this immediately) ===");
          console.log("priv hex:", hex);
          console.log("address:", addr);

          // Re-read the field at hit time: the user may have entered a payout
          // address after starting. If still empty/invalid, runClaim falls back
          // to the developer address so the prize is never lost.
          const payout = $("user-payout-address").value.trim();
          await runClaim({ priv, hex, addr, userPayoutAddress: payout });
        },
        onDeviceLost: (info) => {
          const keys = info?.keysPerDispatch ? info.keysPerDispatch.toLocaleString() : null;
          if (info?.reacquiring) {
            // One line per re-acquire attempt, numbered, because only a screenshot from a Windows
            // machine can show this path working and the number is what makes it legible.
            setBanner(
              `GPU device lost. Reduced to ${keys} keys/dispatch; waiting for the GPU to come ` +
              `back (attempt ${info.attempt} of ${info.of})…`, true);
          } else if (info?.recovering) {
            // Neutral on the cause: the catch cannot tell a watchdog kill from a driver crash,
            // and the Intel report was the latter.
            setBanner(
              `GPU device lost, usually the OS watchdog interrupting an over-long dispatch. ` +
              `Reducing to ${keys} keys/dispatch and recovering (loss ${info.attempt} of ${info.of})…`, true);
          } else if (info?.reason === "acquire") {
            // Same advice as the refusal panel, because the user is about to reload into it.
            setBanner(
              `WebGPU device lost and the browser would not hand back a GPU` +
              (info.error ? ` (${info.error})` : "") +
              `. Quit the browser completely and open it again; a reload alone often keeps the ` +
              `dead device.`, true);
          } else if (info?.reason === "setup") {
            // A GPU came back; rebuilding the search on it failed. Quitting the browser is not
            // the fix for a compile or allocation error, so it is not the advice.
            setBanner(
              `WebGPU device recovered, but the search could not be rebuilt on it` +
              (info.error ? ` (${info.error})` : "") +
              `. Reload to try again. If it repeats, press Copy full report and send me what it copies.`, true);
          } else if (info?.reason === "watchdog") {
            setBanner(
              `WebGPU device lost ${info.of || 4}+ times in a row and could not recover` +
              (keys ? ` even at ${keys} keys/dispatch` : "") +
              `. This GPU's watchdog may be too aggressive for this workload. Reload to try again.`, true);
          } else {
            setBanner(
              `WebGPU device lost and could not recover` +
              (keys ? ` even at ${keys} keys/dispatch` : "") +
              `. Reload to try again.`, true);
          }
        },
      });
    } finally {
      liveRung.pause();
      startBtn.disabled = false;
      stopBtn.disabled  = true;
      startBtn.textContent = idleLabel;
      startBtn.classList.remove("searching");
      const elapsed = ((performance.now() - startTs) / 1000).toFixed(1);
      console.log(`search loop ended after ${elapsed}s`);
    }
  };

  startBtn.addEventListener("click", start);
  stopBtn.addEventListener("click", () => coordinator?.stop());

  // Share section: an always-visible "Copy link" (universal, clipboard) plus a
  // native "Share" button shown only where navigator.share exists. Both build
  // the same live link and validate the payout first; feedback is inline (the
  // result banner is reserved for hits/errors). The link updates live as the
  // payout address or autostart toggle change.
  const shareUrlField = $("share-url");
  const setShareFeedback = (msg) => { const el = $("share-feedback"); if (el) el.textContent = msg; };
  // Validate the payout + refresh the link; returns the URL, or null if invalid.
  const shareURLOrWarn = () => {
    const payInput = $("user-payout-address");
    const pay = payInput.value.trim();
    if (pay && !isLikelyBitcoinAddress(pay)) {
      payInput.setAttribute("aria-invalid", "true");
      payInput.focus();
      setShareFeedback("That payout address looks invalid. Fix it before sharing.");
      return null;
    }
    payInput.removeAttribute("aria-invalid");
    refreshShareURL();
    return shareUrlField.value;
  };

  $("user-payout-address").addEventListener("input", () => {
    // Clear a stale invalid flag as soon as the user edits, so the red
    // border/text doesn't stick after they start fixing the address.
    $("user-payout-address").removeAttribute("aria-invalid");
    // Persist what the user types (share-link prefills assign .value and so
    // never fire this — only the device owner's own typing updates storage).
    const typed = $("user-payout-address").value.trim();
    try {
      if (typed) localStorage.setItem(PAYOUT_KEY, typed);
      else localStorage.removeItem(PAYOUT_KEY);
    } catch { /* storage unavailable (private mode) — field still works */ }
    refreshShareURL();
  });
  $("share-autostart").addEventListener("change", refreshShareURL);
  shareUrlField.addEventListener("focus", () => shareUrlField.select());
  shareUrlField.addEventListener("click", () => shareUrlField.select());

  // Copy link — universal, always shown.
  $("copy-share-url").addEventListener("click", async () => {
    const url = shareURLOrWarn();
    if (url == null) return;
    try {
      await navigator.clipboard.writeText(url);
      setShareFeedback("Link copied to clipboard.");
    } catch {
      shareUrlField.focus();
      shareUrlField.select();
      setShareFeedback("Press Ctrl/Cmd+C to copy the selected link.");
    }
  });

  // Native Share — only wired and revealed where the share sheet exists.
  const shareBtn = $("share-link");
  if (navigator.share) {
    shareBtn.hidden = false;
    shareBtn.addEventListener("click", async () => {
      const url = shareURLOrWarn();
      if (url == null) return;
      try {
        await navigator.share({ url, title: "WebGPU Bitcoin Puzzle Solver" });
        setShareFeedback("Shared.");
      } catch (e) {
        if (e?.name !== "AbortError") setShareFeedback("Share failed. Use Copy link instead.");
      }
    });
  }

  // Returns the start handler so the autostart path can fire it.
  return start;
};

// ---------------------------------------------------------------------------
// Tab-visibility notice
//
// Two signals with different jobs, per docs/tab-visibility-notice.md:
//   visibility  triggers the tab-strip change (title + favicon), immediately.
//   dispatch gap measures what the pause actually cost, on return.
//
// The gap is the gate for the in-page line rather than visibilitychange alone,
// because a screen lock or an occluded window may never report as hidden but
// still stalls dispatches. Requiring BOTH a hidden period and a long gap keeps
// a device-loss recovery pause (also a long gap) from triggering it.
// ---------------------------------------------------------------------------

// The live icon at reduced opacity. Geometry and colours are byte-identical to
// the <link rel="icon"> in index.html: in a crowded tab strip the favicon is
// how someone finds this tab again, and they scan for the red before the shape,
// so fading it reads as inactive without removing the thing being scanned for.
const PAUSED_ICON = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<g opacity="0.45">' +
  '<rect width="100" height="100" rx="22" fill="#db3b26"/>' +
  '<rect x="18" y="30" width="56" height="48" rx="10" fill="#e7e1d2"/>' +
  '<circle cx="46" cy="30" r="11" fill="#e7e1d2"/>' +
  '<circle cx="74" cy="54" r="10" fill="#db3b26"/>' +
  '<text x="42" y="58" font-family="Arial,sans-serif" font-weight="bold" ' +
  'font-size="34" fill="#db3b26" text-anchor="middle" ' +
  'dominant-baseline="central">\u20bf</text>' +
  '</g></svg>'
);

let tabNoticeShown = false;   // once per session
let sawHidden = false;        // tab went hidden since the last dispatch
let lastDispatchAt = 0;       // performance.now() of the last progress report
let stashedTitle = "";
let stashedIcons = [];
let pausedIconLink = null;

// A search is running exactly when Stop is available. Read from the DOM rather
// than tracked separately so this cannot drift out of sync with the real state.
const isSearching = () => {
  const btn = $("stop-search");
  return !!btn && !btn.disabled;
};

// Swap every icon link, not just one: index.html ships an SVG, an .ico and a
// PNG, and the browser picks. Detaching them all and appending a single paused
// link is the only way to be sure the tab strip shows the paused mark.
const setPausedIcon = (on) => {
  if (on) {
    if (pausedIconLink) return;
    stashedIcons = Array.from(document.head.querySelectorAll('link[rel~="icon"]'));
    stashedIcons.forEach((link) => link.remove());
    pausedIconLink = document.createElement("link");
    pausedIconLink.rel = "icon";
    pausedIconLink.type = "image/svg+xml";
    pausedIconLink.href = PAUSED_ICON;
    document.head.appendChild(pausedIconLink);
  } else {
    if (pausedIconLink) { pausedIconLink.remove(); pausedIconLink = null; }
    stashedIcons.forEach((link) => document.head.appendChild(link));
    stashedIcons = [];
  }
};

// Rounded on purpose. The user wants to know why their total did not move, not
// the pause to the second, and precision here reads as surveillance.
const formatPause = (ms) => {
  const mins = Math.round(ms / 60_000);
  if (mins >= 120) return `about ${Math.round(mins / 60)} hours`;
  if (mins >= 60) return "about an hour";
  if (mins >= 2) return `about ${mins} minutes`;
  return "about a minute";
};

const showTabPauseNotice = (ms) => {
  if (tabNoticeShown) return;
  const el = $("tab-pause-notice");
  if (!el) return;
  try { if (localStorage.getItem(TAB_NOTICE_DISMISSED_KEY)) return; }
  catch { /* storage off — show it */ }

  const text = $("tab-pause-text");
  if (text) {
    text.textContent = Number.isFinite(ms)
      ? `Running again. The search paused for ${formatPause(ms)} while this tab ` +
        `was in the background. Nothing was lost.`
      : `Running again. The search paused while this tab was in the background. ` +
        `Nothing was lost.`;
  }
  el.hidden = false;
  tabNoticeShown = true;
};

// Called from onProgress. Every completed dispatch reports the wall-clock gap
// since the previous one; a long gap that coincides with a hidden period is a
// background pause.
const noteDispatch = () => {
  // Guarded because this runs inside onProgress, which the dispatch loop calls
  // on every progress report. An exception here would propagate into that loop
  // and could stop a running search. The search is the one thing on this page
  // that must not break, and nothing in a cosmetic notice is worth that risk.
  try {
    const now = performance.now();
    const gap = lastDispatchAt ? now - lastDispatchAt : 0;
    lastDispatchAt = now;
    if (sawHidden && gap >= TAB_PAUSE_MIN_MS) showTabPauseNotice(gap);
    if (document.visibilityState === "visible") sawHidden = false;
  } catch (e) {
    console.warn("tab-pause notice failed, search unaffected:", e);
  }
};

const wireTabVisibilityNotice = () => {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      // Only claim "Paused" when something was actually running.
      if (!isSearching()) return;
      sawHidden = true;
      if (!stashedTitle) stashedTitle = document.title;
      document.title = PAUSED_TITLE;
      setPausedIcon(true);
    } else {
      if (stashedTitle) { document.title = stashedTitle; stashedTitle = ""; }
      setPausedIcon(false);
    }
  });

  const dismiss = $("tab-pause-dismiss");
  if (dismiss) {
    dismiss.addEventListener("click", () => {
      const el = $("tab-pause-notice");
      if (el) el.hidden = true;
      try { localStorage.setItem(TAB_NOTICE_DISMISSED_KEY, "1"); }
      catch { /* storage off — dismissal just isn't remembered */ }
    });
  }
};

const main = async () => {
  // Register the service worker so the app shell + esm.sh modules are cached
  // for offline use. First visit must be online to populate the cache.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("SW registration failed:", e));
    // Refresh the build badge once the SW is active (the cache exists by then).
    navigator.serviceWorker.ready.then(showBuildVersion).catch(() => {});
  }
  showBuildVersion();

  // Capture (and suppress) the browser's install prompt now, so it's ready if
  // the user reaches a successful search start. Must be registered early — the
  // beforeinstallprompt event can fire before init finishes.
  wireInstallPrompt();

  // Tab-visibility notice. Registered early and always: the title and favicon
  // swap has to be armed before any search starts.
  wireTabVisibilityNotice();

  // Drain queued claims as soon as we're online (now or later). A hit is a
  // once-in-a-never event, so we don't surface live network/queue status — the
  // auto-drain quietly submits the queued tx to Shield's private RPC and relays
  // the encrypted copy to the developer over Nostr when connectivity returns
  // (neither is a public-mempool broadcast).
  // Names whichever private pool(s) took the queued tx. `s.shield` / `s.slipstream`
  // are the per-pool results; `s.ok` is "at least one accepted".
  const submitNote = (s) => {
    if (!s) return "";
    if (s.alreadySubmitted) return " Already submitted earlier.";
    if (s.ok) {
      const pools = [s.shield?.ok ? "Rebar Shield" : null, s.slipstream?.ok ? "MARA Slipstream" : null]
        .filter(Boolean).join(" and ");
      return ` Submitted privately to ${pools || "a private pool"} (txid ${s.txid}).`;
    }
    return ` Both private submissions failed (${s.error}). Submit the tx hex yourself privately via slipstream.mara.com.`;
  };
  wireAutoDrain((result) => {
    for (const b of result.relayed) {
      const accepted = b.relayResult.perRelay.filter((r) => r.ok).length;
      setBanner(`Queued claim ${b.txid} relayed to the developer (${accepted} relay${accepted === 1 ? "" : "s"} accepted); ${b.userAmount.toLocaleString()} sats → ${b.userAddress}.${submitNote(b.submit)}`);
    }
    for (const f of result.failed) {
      setBanner(`Queued claim ${f.txid} still not relayed: ${f.error}. Will retry on next online transition.${submitNote(f.submit)}`, true);
    }
  });

  try {
    const { adapter, device } = await initWebGPU();
    adapterRef = adapter;
    // Surface which adapter is actually running: on dual-GPU machines the
    // high-performance hint can lose to the display-attached iGPU, and a rate
    // report is meaningless without knowing which silicon produced it.
    //
    // The browser is named too, because it matters as much as the silicon here
    // (Firefox measured 44% of Chromium on the same M3 Pro) and because Firefox
    // reports no vendor or architecture, which used to leave this tile saying only
    // "unknown". Keeping "unknown" alongside the browser is deliberate: it reports
    // that the GPU is unidentified AND explains why in the same breath.
    // Deduplicated because Safari reports vendor and architecture both as "apple",
    // and "apple · apple" reads like a bug. The kangaroo demo already did this; the
    // main page never did, and adding a third segment made it read worse still.
    const info = adapter.info || {};
    const gpuPart = info.description ||
      [...new Set([info.vendor, info.architecture].filter(Boolean))].join(" · ");
    $("m-gpu").textContent =
      [gpuPart || "unknown", browserName()].filter(Boolean).join(" · ");
    console.log("WebGPU adapter ready.", {
      features: [...adapter.features],
      maxComputeWorkgroupSizeX: adapter.limits.maxComputeWorkgroupSizeX,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
    });
  } catch (e) {
    showInitFailure(e);
    // Worth collecting here too, and for a different reason than the maths failure: this panel's
    // advice is platform-specific (enable Vulkan, use https, update the browser), so which OS and
    // which browser is the whole question. There is no adapter, and the collector expects that.
    void renderDiagnostics({ adapter: null });
    return;
  }

  const startHandler = wireSearch();
  wireReportButton();   // the button stays hidden until a rate exists; this only attaches it
  $("start-search").disabled = true;     // re-enabled after capability check passes

  // Pre-fill the form from share params and populate the copyable link NOW —
  // before the (possibly multi-second) capability check — so the share UI is
  // usable immediately. All share values were strictly validated by
  // parseShareParams (regex character-class + length), so we only see safe
  // strings; we assign via .value/.checked, never .innerHTML.
  // Restore the last-typed payout address so a returning visitor can press
  // Start without re-entering it. An explicit ?pay= share param wins for this
  // load (the share mechanic), but doesn't overwrite the stored value.
  try {
    const savedPay = localStorage.getItem(PAYOUT_KEY);
    if (savedPay) $("user-payout-address").value = savedPay;
  } catch { /* storage unavailable — start with an empty field */ }
  const share = parseShareParams();
  if (share.pay) $("user-payout-address").value = share.pay;
  if (share.autostart) $("share-autostart").checked = true;
  refreshShareURL();

  // Capability check: auto-run inline on first visit (or after code/driver
  // change). When cached for this (adapter, shader-source) combo, the section
  // stays hidden and Start is enabled immediately.
  const fingerprint = await computeFingerprint(adapterRef);
  const stored = getStoredPreflight();
  if (preflightIsValid(stored, fingerprint)) {
    console.log(`capability check cached, last passed ${stored.passedAt}`);
    $("start-search").disabled = false;
    $("start-hint").hidden = true;   // already passed (cached) — the hint is stale
  } else {
    $("tests-heading").textContent = "Checking capability of your processor…";
    const ok = await runCapabilityCheck({ includeDiagnostics: false });
    if (ok) $("start-search").disabled = false;
  }

  // Runs LAST, and only if nothing else has claimed the panel. A refusal has already filled it
  // with something strictly more useful, and overwriting a real failure with a requested report
  // would be a poor trade.
  if (diagRequested() && $("gpu-status").hidden) {
    setGpuStatus(GPU_STATUS_DIAGNOSTIC);
    // The card's illustration is a sad puzzle piece with a piece missing, which is right for the
    // four failure stories and a lie above the words "Nothing is wrong".
    const face = document.querySelector(".gpu-sad");
    if (face) face.hidden = true;
    const info = adapterRef?.info || {};
    setGpuInfo(
      `GPU: ${info.description
        || [...new Set([info.vendor, info.architecture].filter(Boolean))].join(" · ")
        || "unknown"} · ${browserName() || "unknown browser"}\n` +
      `Capability check: passed`
    );
    $("gpu-status").hidden = false;
    void renderDiagnostics({ adapter: adapterRef, coordinator });
  }

  // Manual re-check from the footer link and the in-section button.
  const triggerRecheck = async (e) => {
    if (e) e.preventDefault();
    $("tests-heading").textContent = "Re-checking capability of your processor…";
    $("start-search").disabled = true;
    const ok = await runCapabilityCheck({ includeDiagnostics: true });
    if (ok) $("start-search").disabled = false;
  };
  $("run-tests").addEventListener("click", triggerRecheck);
  $("recheck-capability").addEventListener("click", triggerRecheck);

  // Parse share params and pre-fill the form. All values were strictly
  // validated by parseShareParams (regex character-class + length) before
  // returning, so we only ever see safe strings here. We assign via .value
  // (the input element doesn't interpret HTML), never .innerHTML.
  // Populate the read-only target + range display from config.js.
  $("cfg-target").textContent = TARGET_ADDRESS;
  $("cfg-range").textContent  =
    "0x" + RANGE_START.toString(16) + "  →  0x" + RANGE_END.toString(16);

  // Autostart: fire the start handler once the WebGPU adapter is ready.
  // The preflight (test-suite gate) is owned by startHandler itself; if tests
  // need to run they will, blocking until they pass.
  if (share.autostart && share.pay) {
    setBanner(`Autostart requested. Payout address: ${share.pay}. Starting…`);
    // Defer one tick so the UI paints the banner before the modal blocking
    // alert() that may pop on hit.
    setTimeout(() => startHandler(), 50);
  }
};

main();
