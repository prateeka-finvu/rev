# FIU Revenue Estimator (backend + config storage)

This is the backend version of the tool: FIU metadata (legal name, TSP,
license type, use-case, billing model) and yield/CMGR are maintained as
**configs** that persist on the server, so a monthly upload only needs to
carry AU/DF counts — not the same metadata over and over.

Because it now stores data server-side, it needs an actual running process
(unlike the earlier single-file version, this can't be hosted on GitHub
Pages — see "Deploying" below).

## What's in each config

**FIU Metadata** (`FIU Metadata` tab): FIU ID, Legal Name, TSP Name, License
Type, Use-case, Billing Model, and **Top 10** (Yes/No) — a manually-set flag
for a FIU that belongs to the org's "Top 10" watchlist for its use-case. It
doesn't affect any revenue calculation; it only drives the Top 10 - Lending
and Top 10 - PFM sections described under Monthly workflow below. Re-running
**Import / update from Master Data file** never touches this flag either way
(that file doesn't carry a Top 10 column), so it's safe to re-seed without
losing who's flagged.

**Yield & CMGR** (`Yield & CMGR` tab): FIU ID, Yield, CMGR (compound monthly
growth rate, as a decimal — `0.05` for 5% monthly growth, `0` for flat,
negative values are fine for a shrinking FIU), plus **SUC Cliff CMGR**,
**SUC Recovery CMGR**, and **SUC Yield** — a per-Data-Fetch rate plus two
growth rates for the two halves of the SUC period. By default these are just
tracked for reference and don't affect the calculation; set a **SUC Start
Date** on the Monthly Revenue tab to actually switch a FIU over to them from
that month onward (see "SUC Start Date" under Monthly workflow below). From
that month on, the FIU's revenue is **SUC Yield × expected Data Fetch
volume** — its regular Unique-User billing no longer applies, even for a FIU
whose Billing Model is "Unique Users". Because Data Fetch volume is
typically many times larger than Active/Unique User counts for the same
FIU, **SUC Yield needs to be entered as a genuine per-Data-Fetch rate**
(usually much smaller than the regular per-user Yield) — not just a second
number in the same range as Yield, or FY totals after the switch will run
far higher than intended. SUC Recovery CMGR can be left blank — a FIU
without one just keeps growing at its regular CMGR once the SUC Recovery
quarter starts (see "SUC Cliff vs. SUC Recovery" below). It ships pre-seeded
with each FIU's regular CMGR as a starting point (so it's visible instead of
blank and matches the pre-split default behavior) — edit any FIU's value on
the Yield & CMGR tab to make its Recovery growth diverge from its regular
CMGR. The 98 FIUs with no regular CMGR on record were left blank rather than
seeded with a guess. The 33 FIUs with Use-case "PFM" and a License Type
other than "Bank" have SUC Recovery CMGR set to **0** specifically (ask:
2026-08-19) rather than the regular-CMGR default — edit any of them
individually on the Yield & CMGR tab if that's not the right Recovery
assumption for a particular FIU.

Both are stored as plain JSON files under `data/` (`fiu-metadata.json`,
`yield-cmgr.json`) — no database server to install. That's a deliberate
choice for a dataset of a few hundred FIUs maintained by a small team; swap
`lib/store.js` for a real database later if you need concurrent multi-writer
support.

**Historical actuals** (`data/historical-actuals.json`) — one row per FIU
per month for any month you've recorded real, final actuals for (currently
Apr–Jul 2026, seeded with the app). See "Historical actuals" under Monthly
workflow below. Add new months from the **Historical Actuals** tab once
they end — upload a file with `FIU ID` and any of `Revenue`, `active_users`,
`successful_data_fetches` for a chosen month, or add/edit/delete individual
rows by hand. Uploading a month only ever touches that month's FIU rows —
every other month and FIU is left untouched, so it's always safe to run.
`billingModel`/`billingYield` on each row are captured from the FIU
Metadata/Yield & CMGR configs at upload time, for reference only — they
aren't used in any calculation, only the row's own `revenue`/`auCount`/
`dfCount` are.

Yield, CMGR, SUC Cliff CMGR, SUC Recovery CMGR, and SUC Yield are all
displayed rounded to 2 decimal places throughout the Monthly Revenue tab and
the Yield & CMGR config table (the underlying stored values keep full
precision — only the display is
rounded).

## Monthly workflow

1. Each month, export just **FIU ID, active_users, successful_data_fetches**
   from your live system (no yield, no billing model, no metadata needed).
2. Upload that file in the **Monthly Revenue** tab's side panel (on the left
   — kept separate from, and sticky alongside, the results on the right) and
   set the as-of date (the date the counts were actually pulled/finalized as
   of — **defaults to yesterday, not today**; see the callout below for why —
   change it if the file you're using doesn't have that lag).
   There's no "Compute" button — results appear as soon as a file is chosen,
   and recompute automatically whenever you change the as-of date, FY start
   month, or SUC Start Date.

   > **Why "yesterday", not "today"?** (found 2026-09-02) A daily counts
   > export is usually dated/generated today but only actually contains data
   > through end of the *previous* day — a one-day reporting/ETL lag that's
   > standard for a batch export like this. The as-of date drives the
   > month-to-date → full-month Data Fetch projection (day-of-month ÷ days in
   > that month) — if it's set to "today" but the file only has one real day
   > of data, that projection divides by one extra day it shouldn't, roughly
   > **halving** the projected month, which then compounds through every
   > later SUC month. Confirmed against a real Metabase export: treating it
   > as "today" understated projected FY revenue by ~39% (₹13.6cr vs. an
   > independent reference model's ₹22.2cr); treating the same file as
   > "yesterday" landed within ~2% of that reference (₹22.6cr). The default
   > is just a starting point — always override it if a particular file's
   > timing is different (e.g. a same-day manual pull with no lag).
   >
   > "Yesterday" is measured on the **India Standard Time (UTC+5:30)**
   > calendar — the timezone the daily export and the business day it
   > reports on both run on — not the server's own clock. Render runs the
   > server on UTC, which is 5:30 behind IST, so for the tail end of each
   > IST day (IST 00:00–05:29, i.e. UTC 18:30–23:59 the day before) the raw
   > UTC calendar date is still a day behind the IST one. Computing
   > "yesterday" from the server's UTC clock during that window showed a
   > default one full day stale — e.g. still showing Sep 1 at 3am IST on
   > Sep 3, instead of Sep 2 (fixed 2026-09-03).
3. The tool joins the upload with both configs by FIU ID and computes:
   - **Current month revenue** — "Active Users"/"Unique Users" (same
     billing model) use the AU count as-is; "Data Fetch"/"Fix Billing"
     project the DF count from a month-to-date total to a full month using
     the as-of date (day-of-month ÷ days in that month).
   - **Every remaining month of the FY** — the current month's baseline
     usage (AU as-is, or the already-projected full-month DF figure) is
     grown by `(1 + CMGR)` compounded per month; yield is held constant.
     Revenue = usage × yield for every month.
   - **SUC Start Date** (dropdown next to As-of date/FY start month, options
     Oct 2026 – Mar 2027, default "None") — from that month onward, any FIU
     with **both** SUC Cliff CMGR and SUC Yield set on the Yield & CMGR tab
     switches its revenue to **SUC Yield × expected Data Fetch volume**,
     for the rest of the FY — regardless of that FIU's regular billing
     model. Unique-User billing does not apply once SUC is in effect: even
     a FIU billed on Active/Unique Users switches onto its (projected)
     Data Fetch volume from the switch month onward. A FIU missing SUC
     Cliff CMGR or SUC Yield, or with no usable DF count to switch onto, is
     left on its regular Yield/CMGR for the whole FY rather than guessed,
     and both cases are called out in the Monthly results note. Months (and
     the current-month revenue cell, if the switch date has already passed)
     governed by SUC values are highlighted amber in every revenue/AU/DF
     table. Leaving it on "None" reproduces the exact behavior from before
     this option existed.
   - **SUC Cliff vs. SUC Recovery** — the SUC period isn't one flat growth
     rate. **SUC Yield stays the same for the whole SUC period** — only the
     Data Fetch growth rate changes partway through, and each half has its
     own configurable rate on the Yield & CMGR tab:
     - **SUC Cliff**: the SUC Start Month plus the following 2 months (3
       months total). Data Fetch volume compounds at **SUC Cliff CMGR**
       here — modeling an expected dip right after a price increase.
     - **SUC Recovery**: every SUC-active month after the 3-month Cliff
       window, for the rest of the FY. Data Fetch volume compounds at
       **SUC Recovery CMGR** — modeling usage recovering once the market
       adjusts to the new pricing — while still being billed at SUC Yield.
       **SUC Recovery CMGR can be left blank**: a FIU without one just
       keeps growing at its regular (pre-SUC) CMGR once Recovery starts,
       same as before this field existed.
     - If the SUC Start Month is late enough in the FY that the 3-month
       Cliff window runs past March close-out (SUC Start Month = Jan, Feb,
       or Mar), the FY simply ends before Recovery ever kicks in — every
       SUC-active month shown that year is Cliff. (E.g. SUC Start Month =
       Feb'27 → only Feb'27 and Mar'27 are SUC-active, and both are Cliff;
       Recovery would only start in Apr'27, which is next FY.)
     - SUC-active revenue/AU/DF cells are hoverable — the tooltip says
       whether that particular month is Cliff or Recovery (and, for
       Recovery, whether it's using SUC Recovery CMGR or falling back to
       the regular CMGR), in addition to the amber highlight marking it as
       SUC-governed.
   - **What-if revenue scenarios** — optional, opt-in checkboxes ("What-if
     scenarios" field, shown once a SUC Start Date is set) that adjust how
     SUC-active months are computed, on top of everything above. Any
     combination can be turned on together — they target disjoint FIU
     populations, so there's no interaction to worry about between them:
     - **Lending DF volume falls 50% (not ~34%) during SUC Cliff** — for
       every Lending-use-case FIU whose own SUC Cliff CMGR is already
       negative, during the SUC Cliff only (the first 3 months of the SUC
       period), that FIU's Cliff-phase monthly rate is replaced with a flat
       **-20.63%/month** — the constant rate that compounds to exactly a
       50% cumulative fall over 3 months, versus the ~34% fall a typical
       -13%/month Cliff CMGR produces on its own (fixed 2026-09-03; this
       used to multiply each FIU's own Cliff CMGR by 1.5, which for a
       -13%/month baseline only worked out to a 47.8% fall, not 50%). A
       Lending FIU whose Cliff CMGR is zero or positive is left completely
       untouched — there's no sensible "worse" reading for a FIU that isn't
       already degrading. SUC Recovery is deliberately left untouched
       either way: recovery is still assumed to happen at the
       originally-anticipated pace, not accelerated. Pre-SUC months, and
       FIUs SUC doesn't apply to, are untouched too.
     - **Non-bank PFM FIUs → ₹0 post-SUC** — for every PFM-use-case FIU
       whose License Type isn't Bank (the same population the 1/6 DF cut
       above applies to), revenue is forced to ₹0 for every SUC-active
       month — shown as an explicit ₹0, not a missing/"—" figure. Usage/DF
       figures for those FIUs and months are still shown as normal; only
       revenue is zeroed.
     Checking a box re-runs the compute automatically, same as any other
     field on this tab. The response's `scenariosApplied` field lists
     whichever scenario keys were actually turned on for that compute, and
     `GET /api/scenarios` returns the checkbox labels/descriptions — see API
     reference below.
   - **One-off manual overrides** (hardcoded in `lib/compute.js`, not
     exposed in the UI — added on request, keep this list updated if more
     are added or these are removed):
     - PFM-use-case FIUs whose License isn't Bank get their expected Data
       Fetch volume cut to **1/6** once, at the SUC switch month — it then
       keeps compounding normally (Cliff at SUC Cliff CMGR, then Recovery
       at SUC Recovery CMGR/regular CMGR, per the Cliff/Recovery split
       above) from that reduced baseline.
     - **fiulive@canarabank**: revenue fixed at ₹3,50,000 in Nov 2026 and
       ₹0 every other month of the FY (replaces historical actuals too).
     - **fiulive@moneycontrol**: revenue fixed at ₹1,60,000 every month
       through the month before the SUC Start Date (or the whole FY if no
       SUC Start Date is set); normal computation resumes from the SUC
       Start Date onward.
     - **fiulive@axisbank**: AU count fixed at 25,000 from Sep 2026 onward
       for any month Unique-User billing still applies (i.e. not
       SUC-active); DF count during the SUC period fixed at 10% of the
       recorded July 2026 DF count, flat every SUC month. (Revisited
       2026-09-02 against a newer reference sheet with a different implied
       Oct'26 figure — kept as-is on request.)
     - **ICICI**, **SBI Cards**, **KMBL-FIU-PROD (PFM)**: all three are
       newly onboarding in H2 with no real Data Fetch volume yet, so the
       normal DF-baseline-compounding SUC math has nothing to grow from.
       Each has a flat monthly revenue figure hardcoded for the SUC period
       (from the Sep 2026 reference sheet) — ICICI ₹51,000/month and SBI
       Cards ₹80,000/month, both flat Oct 2026 – Mar 2027; KMBL-FIU-PROD
       (PFM) ₹13,79,669/month Oct–Dec 2026, then ₹2,29,945/month Jan–Mar
       2027. This is a stand-in only: the moment one of these FIUs' *current
       month* upload reports a real (nonzero) Data Fetch count, the flat
       figure stops being used for that FIU — for good, not just that one
       month — and it switches to the normal SUC computation (DF baseline ×
       SUC Yield, Cliff/Recovery CMGR) off that real, growing baseline
       instead. No manual step needed for that switch — it's re-evaluated
       fresh from whatever counts were just uploaded, every time.
     - **fiulive@hdfc** and **HDFC-FIU**: both are "Unbilled" on the FIU
       Metadata tab, which normally excludes a FIU from SUC entirely (SUC
       only ever applies to an otherwise-billable FIU). For just these two,
       that exclusion is waived from the SUC Start Month onward — from
       then on they compute revenue as **DF Count × SUC Yield** exactly
       like any other SUC-configured FIU (Cliff/Recovery split included),
       still gated on having a usable DF count. Before the SUC Start
       Month, they're excluded as normal. Because their Billing Model
       stays "Unbilled" on record, they'll still show up in the **Unbilled
       FIUs** section (section 4) even in months where they're now
       generating real SUC revenue elsewhere on the page — that section
       reflects the billing-model config, not month-by-month billing
       status, so the two aren't mutually exclusive for these two FIUs.
       Their expected Data Fetch volume is also cut by **43%** once, right
       at the SUC switch (assumed to be the share of their DF volume that's
       on-bank data, which they're assumed to stop fetching this way once
       SUC pricing applies to cut costs) — it then keeps compounding
       normally (Cliff/Recovery CMGR) from that reduced baseline, same
       one-time-cut pattern as the PFM/non-Bank 1/6 rule above.
4. **Historical actuals** — the Annual tables show the full fiscal year
   (Apr'26–Mar'27), not just the months from your upload onward. Months
   **before or equal to** your as-of date's month are filled from the
   **Historical Actuals** tab's store, whenever a recorded actual exists for
   that FIU/month, and shown exactly as recorded — actual Revenue,
   active_users, and successful_data_fetches, never recomputed or
   compounded. They're highlighted green in every Annual table. A FIU with
   no recorded actual for a given historical month shows a "no data" badge
   there instead of a blank or a guessed 0 — including the current month
   itself, until you record one, in which case it's used immediately rather
   than waiting for the as-of date to roll into the next month first (fixed
   2026-09-02 — a recorded actual for the current month used to be silently
   ignored in favor of a live projection from that month's uploaded counts,
   until the as-of date moved past it). Historical revenue counts toward FY
   totals and the TSP/Use-case/License rollups even for a FIU that's
   currently unbilled or missing config — real past revenue doesn't
   disappear just because today's config is incomplete. Once a month ends,
   add its real figures on the **Historical Actuals** tab (upload a file, or
   add/edit rows by hand) and it's picked up everywhere above automatically
   — no other step needed. It ships pre-seeded through Jul 2026; extend it
   monthly from there as each new month closes.
5. FIUs whose billing model isn't recognized (blank, "Not billed",
   "Unbilled", or anything else unrecognized) are shown as excluded. FIUs
   missing a Yield & CMGR config entry, or with an unusable count, are shown
   as missing config — never guessed.
6. Any FIU in the upload with no FIU Metadata entry is called out
   separately (and excluded — there's no config to compute it from). A FIU
   in your configs with no counts in this month's upload is also called out
   separately, but **still gets a row** in every Monthly/Annual table:
   months with a recorded Historical Actual show that actual (same as any
   other FIU), and months with no actual and no counts to project from show
   "no data" rather than the FIU vanishing outright (fixed 2026-09-03 — a
   FIU missing from just *this month's* counts upload — e.g. it had no live
   activity this cycle, or simply wasn't in that particular export — used
   to disappear from the Annual tables entirely, taking every past month's
   real recorded revenue with it, until its next counts upload happened to
   include it again).
   If the same FIU ID appears **more than once** in a counts upload (a real
   risk in a hand-merged or re-exported file), only the first row for it is
   used — the rest are called out separately too, rather than silently
   double-counting that FIU's revenue into every total (fixed 2026-09-03).
7. Results are split into two sections:
   - **Monthly results** — this month's revenue, AU count, and DF count,
     each in its own table. The revenue table covers every billed FIU; the
     AU count table lists only FIUs billed on Active/Unique Users. The **DF
     count table lists every FIU that reported a DF count at all**,
     regardless of billing model — a Unique-User-billed FIU's Data Fetch
     volume is visible here even before SUC makes it relevant. Each of the
     three Monthly results tables has a **Contribution %** column — that
     FIU's share of this month's total for that metric (revenue/AU/DF), so
     "—" means either no value this month or the total itself is zero,
     never a misleading 0.0%.
   - **Annual results** — the same three views as full fiscal-year grids,
     Apr'26 through Mar'27 (historical actuals for the months already past,
     computed/projected figures from the current month onward), so you can
     see revenue and AU/DF counts trend across the whole year, not just
     from today forward. The Annual DF count table likewise shows expected
     Data Fetch volume for every FIU with a DF count in **any** month of
     the FY — including a FIU that's Unbilled on record, and including one
     that isn't in *this specific month's* counts upload but has real
     Historical Actuals or a live count in some other month — all twelve
     months; amber highlighting marks the months where that volume is
     actually driving billed (SUC) revenue. This table used to drop a FIU
     entirely (from every month, not just the current one) whenever this
     month's upload didn't happen to include it, or — separately — whenever
     it was Unbilled and no SUC Start Date was set; both fixed 2026-09-03.
     Each of the three Annual tables has a
     **Contribution % (FY total)** column — that FIU's share of the **full
     fiscal year's** total for that metric (revenue/AU/DF), not just the
     current month, so "—" means either no value at all that FY or the FY
     total itself is zero, never a misleading 0.0%.
   Every table on the Monthly Revenue tab can be **sorted** (click a column
   header — click again to flip direction) and **searched** (the box above
   each table filters by substring across FIU ID, legal name, and billing
   model). "Total" footer rows always reflect the full dataset, not just
   what's currently filtered by a search.
8. FIUs with an unrecognized/blank billing model (excluded from revenue) are
   listed in their own **Unbilled FIUs** section, with a total count and
   their combined AU/DF counts, plus a per-FIU breakdown — so unbilled
   volume stays visible instead of just vanishing from the results. The
   per-FIU table has an **AU Contribution %** and a **DF Contribution %**
   column — that FIU's share of the unbilled group's total AU count and
   total DF count respectively (each "—" if that FIU has no count, or if
   the unbilled group's total for that metric is zero).
9. If a billed FIU's Billing Model text includes "Quarterly" or "Annual",
   its row shows a small badge next to the billing model. This is
   informational only — the tool applies the same monthly usage × yield
   formula regardless of that flag; it does **not** currently prorate or
   batch revenue for quarterly/annual billing. If you bill some FIUs on a
   quarterly or annual cycle and want that reflected (e.g. only recognizing
   revenue in the billing month, or dividing/multiplying appropriately),
   that logic isn't implemented yet — the badge just makes today's
   assumption visible instead of silent.
10. Below the per-FIU results, the same figures are also rolled up **by
    TSP, by Use-case, and by License Type** (from the FIU Metadata config)
    — each as its own section with three full FY grids (Apr'26–Mar'27,
    historical + projected, same as above): **Revenue**, **AU count**, and
    **DF count**. A blank field is bucketed as "(Unspecified)" rather than
    dropped, and each grouping's Revenue totals always sum back to the same
    overall FY total as the per-FIU table. The AU count view only rolls up
    FIUs actually billed on Active/Unique Users (matching the per-FIU
    Annual AU count table); the DF count view rolls up every FIU that
    reported a DF count at all, regardless of billing model (matching the
    per-FIU Annual DF count table) — so a Unique-User-billed FIU's Data
    Fetch volume is visible here too, not just once SUC makes it relevant.
    Unlike Revenue, the AU and DF views don't have an FY Total column (same
    convention as their per-FIU counterparts) — just a Total row per month.
    None of these grouped tables (By TSP, By Use-case, By License Type) has
    a Contribution % column.
11. **Top 10 - Lending** and **Top 10 - PFM** sections show the same kind of
    full FY grid, but filtered to just the FIUs flagged **Top 10 = Yes** on
    the FIU Metadata tab, split by that FIU's Use-case: Top 10 - Lending
    covers Revenue and DF count for the flagged FIUs with Use-case
    "Lending"; Top 10 - PFM covers Revenue, AU count, and DF count for the
    flagged FIUs with Use-case "PFM". A FIU flagged Top 10 with some other
    Use-case (or a blank one) won't appear in either section — only
    "Lending" and "PFM" are split out today.
12. **DF Yield Analysis** — `DF Yield = Total Revenue ÷ Total DF Count` for
    three fixed points in the FY: the current (as-of) month, Oct 2026, and
    Mar 2027. Each has an Overall figure plus a By Use-case and By TSP
    breakdown, and a final **By TSP** table compares all three months side
    by side for each TSP. Revenue only counts months that are actually
    billed (same rule used everywhere else); DF Count includes every FIU
    that reported a DF count that month regardless of billing model — the
    same broad population the DF count tables use. That means DF Yield
    reflects revenue earned across the whole Data Fetch footprint, not just
    the FIUs currently billing on it, so it's normal for it to differ from
    any single FIU's configured Yield. Every By Use-case / By TSP breakdown
    sums back exactly to its period's Overall figure. A scope with zero DF
    volume that month shows "—" instead of a divide-by-zero. If Oct 2026 or
    Mar 2027 ever falls outside the current fiscal year (only possible with
    a non-default FY Start Month), that period's tables show an empty
    state instead of guessing.

## Projected vs Actual Revenue

The **Projected vs Actual Revenue** card tracks the live revenue projection
against what actually came in, month by month, for the whole FY. The chart
itself lives on the **Charts** tab; the month-wise figures table stays on
the **Monthly Revenue** tab, right where it always was.

- **Projected** is exactly the current compute result's FY total-by-month —
  same counts file, as-of date, SUC Start Date, and what-if scenario(s) as
  whatever's selected in the live view right now. It recomputes and
  redraws automatically every time you change any of those (a new counts
  file, the as-of date, SUC Start Date, or a scenario checkbox) — same as
  every other chart on the Charts tab. The legend and the "Live as of …"
  line above the month-wise table both spell out exactly what's currently
  driving it, e.g. "SUC from Oct 2026, scenario: Lending DF volume falls
  50% (not ~34%) during SUC Cliff", or "no SUC" with nothing selected.
  - This used to be a manually-saved, frozen "snapshot" — a button you had
    to click, which forced SUC off regardless of what was selected
    elsewhere, and which could easily go stale for weeks since nothing
    prompted you to refresh it. Fixed 2026-09-03: there's no button and no
    stored snapshot anymore, it's just always current, matching every
    other chart on the page.
- **Actual** is not stored anywhere separately — it's summed live, every
  time the chart refreshes, straight from whatever's in **Historical
  Actuals** for each FY month. A month with no historical rows yet shows
  as a gap in the line (not zero) — it fills in automatically once that
  month's actuals are recorded.
- The chart (on the Charts tab) shows both series as a line per month across
  the full FY, with a hover tooltip (crosshair snaps to the nearest month)
  and end-of-line value labels. The month-wise figures table (on the Monthly
  Revenue tab) has the exact numbers plus variance (Actual − Projected) and
  variance %.
- Before the first compute of a session, the chart area just says to upload
  a counts file on the Monthly Revenue tab — nothing else on the page is
  blocked by it.

## Charts tab

The **Charts** tab collects every chart in the tool in one place, so the
Monthly Revenue tab can stay focused on tables. It has four cards:

1. **Projected vs Actual Revenue** — the chart described just above, live
   (the underlying month-wise table remains on the Monthly Revenue tab).
2. **Revenue by Use-case** — four series, all in ₹, labels shown in Cr/L:
   - **Total Revenue** — that month's total revenue across all billed FIUs
     (not cumulative).
   - **Lending Revenue** / **PFM Revenue** — that month's revenue from FIUs
     whose use-case rolls up to Lending / PFM respectively (same grouping as
     the Use-case rollup tables elsewhere in the tool).
   - **Cumulative Revenue** — a running total of Total Revenue from the
     start of the FY through that month. By March this is roughly the whole
     FY total, an order of magnitude above any single month's figure, so it
     plots against its **own scale on the right-hand axis** — otherwise it
     would stretch the shared axis and flatten the other three series into
     an unreadable sliver near the bottom.
3. **Data Fetch Count by Use-case** — the same structure as the revenue
   chart, but for Data Fetch counts: **Total DF Count**, **Lending DF
   Count**, **PFM DF Count** (all monthly, not cumulative, left axis), plus
   **Cumulative DF Count** as a running total (right axis, same reasoning as
   Cumulative Revenue above).
4. **PFM vs Lending Split (%)** — four series showing, for each month, what
   share of that month's revenue and DF count came from PFM vs Lending:
   **Lending Revenue %**, **PFM Revenue %**, **Lending DF %**, **PFM DF %**
   (one shared axis — all four are already the same 0-100% scale). Each pair
   (Lending/PFM) should sum to ~100% of the billed total for that metric in
   that month — the split is based on that month's own numbers, not a
   cumulative-to-date share. A month shows a gap instead of 0% if the
   underlying total for that metric is zero (avoids implying a real 0%
   split when there was nothing to split).

All charts on this tab share the same interaction as the Projected vs Actual
chart: hover for an exact-value tooltip with a crosshair, and end-of-line
value labels for every series. Labels are automatically nudged apart if two
series' final values would otherwise land too close together, and every
label has a subtle halo in the card's own background color so it stays
readable even where a line (or another series tracking a near-identical
value) passes directly behind it.

## Auto-pull counts from email

Instead of manually choosing a counts file every day, the Monthly Revenue
tab can auto-pull the current month's counts straight from a Gmail inbox —
so a plain page refresh shows updated numbers as soon as that day's email
has arrived, no upload step required.

**How it works**: this is built for the common setup where a Metabase
Dashboard Subscription emails a CSV export on a schedule. On every page
load (and whenever you change As-of date / FY start month / SUC Start
Date), the app checks the inbox over IMAP for the most recently received
email — within the last 14 days — whose subject contains a text you
configure, that has a CSV attached, and computes the FY revenue curve from
that attachment exactly as if you'd uploaded it by hand. A short-lived
cache (5 minutes by default) avoids re-checking the inbox on every single
refresh; the **Check email now** button always bypasses it for a live
check.

**Setup** — requires a Gmail or Google Workspace inbox:

1. Turn on 2-Step Verification on the Google account if it isn't already
   (required for the next step).
2. Generate an **App Password** at
   [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
   — a 16-character password scoped to this one use, separate from the
   account's real password.
3. In `.env` (copy `.env.example` if you haven't already), set:
   - `GMAIL_USER` — the Gmail address the Metabase email arrives at.
   - `GMAIL_APP_PASSWORD` — the App Password from step 2.
   - `METABASE_EMAIL_SUBJECT` — text that must appear in the subject line,
     e.g. the name of the Metabase subscription ("Daily FIU Counts"). This
     is a case-insensitive substring match, same as Gmail's own search.
4. Restart the server. Leave all three unset to keep the app running on
   manual upload only — nothing else changes if they're blank.

**Manual upload still works as an override**: choosing a file via
**Choose counts file** takes over immediately and stays in effect (even
across As-of date/FY start month/SUC Start Date changes) until you click
**Use auto-pulled email data instead** or refresh the page, at which point
it goes back to whatever the latest matching email currently is.

**What counts as a match**: the newest email (by received date, checked
against emails from the last 14 days) whose subject contains
`METABASE_EMAIL_SUBJECT` and that has a `.csv` attachment (or an attachment
whose content type is `text/csv`). An email matching the subject with no
CSV attached is skipped in favor of an older one that does have one, rather
than failing outright. If nothing matches, the app shows a clear status
message and falls back to whatever was last shown (or an empty state on a
fresh server) — the manual upload path is unaffected either way.

Note: the "Projected vs Actual Revenue" chart no longer needs a manually
chosen file of its own — since 2026-09-03 it just tracks whatever the live
compute result is (auto-pulled from email or manually uploaded, either
one), same as every other chart on the page. See "Projected vs Actual
Revenue" above.

## Seeding the configs quickly

If you already have a Master-Data-style spreadsheet (a sheet literally named
"Master Data" with `fiu_id`, `fiu_name`, `TSP`, `License`, `Use-case`,
`Billing Model`, a yield column, and optionally a CMGR/"Q2 CMGR Forecast"
column), use **Import / update from Master Data file** on the FIU Metadata
tab — it seeds *both* configs at once instead of retyping every row by hand.
Only the "Master Data" sheet is read; any other sheets in that file are
ignored. Re-running it later updates existing FIUs and adds new ones (an
upsert, not a wipe) — and, as of the fix below, an upsert of *only the
columns this particular file actually has*: a re-import whose file is
missing (or renames) a column no longer blanks that field on every FIU it
touches. It used to (fixed 2026-09-03) — e.g. re-importing a file with no
Billing Model column would silently wipe every FIU's billing model to
blank, dropping them out of revenue entirely, with nothing on screen to
explain why numbers had changed. A column that's present but blank for a
specific row still clears that field for that row — that's the file
explicitly saying "empty" for a column it does include; it's only a
missing/renamed column that's now left alone.

**A note on one technical FIU ID covering more than one use-case**: both
configs key rows by FIU ID, one row per ID. If a single technical FIU ID's
traffic is actually a blend of two use-cases (e.g. one integration serving
both Lending and PFM) and your monthly counts export only ever produces one
row for it, you can still track the second use-case for planning purposes —
add it as its own row with a distinguishing FIU ID, e.g. `KMBL-FIU-PROD
(PFM)` alongside the real `KMBL-FIU-PROD`. It'll show up in both config
tabs and in the Monthly Revenue tab's "no counts uploaded this month" list,
but won't get computed revenue until your counts export can actually
attribute usage to it separately.

## Running it locally

```
npm install
npm start
```

Then open `http://localhost:3000` (or set `PORT=xxxx npm start` to use a
different port). Data persists in `data/*.json` between restarts.

To enable the chat feature (see below), set `ANTHROPIC_API_KEY` before
starting the server — either inline:

```
ANTHROPIC_API_KEY=sk-ant-... npm start
```

or, more conveniently, by copying `.env.example` to `.env` and filling in
your key:

```
cp .env.example .env
# then edit .env and paste in your key
npm start
```

The server loads `.env` automatically on startup (via the `dotenv`
package) if one exists next to `server.js` — you only have to set the key
once instead of re-exporting it in every terminal session. `.env` is
gitignored, so it won't get committed if you put this in version control.
If there's no `.env` file, nothing changes — the server just falls back to
whatever's already in the environment (or runs with chat disabled, if
neither is set).

## Chat with your data

There's a floating chat button (bottom-right of the page, once you've
computed a month) that opens a panel where you can ask plain-English
questions about the currently computed FY data — e.g. "which TSP has the
highest DF Yield this month?", "how many FIUs switched to SUC?", "what's
driving the jump in Lending revenue in October?". It's backed by the real
Anthropic API (Claude) — not a canned/rule-based Q&A engine — so it can
handle genuinely open-ended questions, not just a fixed menu of them.

**Setup** — this requires your own Anthropic API key:

1. Get an API key from the [Claude Platform console](https://platform.claude.com).
2. Set it as the `ANTHROPIC_API_KEY` environment variable on whatever machine
   runs the server — the easiest way is the `.env` file described above
   under "Running it locally" (or your host's env-var settings if
   deployed). The key is only ever read server-side from this env var —
   it's never sent to or stored in the browser, and never hardcoded
   anywhere in this codebase.
3. Optionally set `ANTHROPIC_MODEL` to override the default model
   (`claude-sonnet-5`) — e.g. to use a cheaper/faster or more capable model.
4. Restart the server. If the key isn't set, the chat panel still opens but
   shows a clear error explaining it's not configured, instead of the rest
   of the app breaking.

**How it works** — when you ask a question, the browser sends your message
history plus the full currently-computed dataset (whatever `/api/compute`
last returned) to `POST /api/chat`. The server condenses that into a much
smaller JSON block (`lib/chat.js`'s `buildChatContext` — per-FIU monthly
figures as compact `[revenue, auUsage, dfUsage, billable]` arrays, integers
only, plus the existing TSP/Use-case/License groupings and the DF Yield
Analysis block) and sends it to the Anthropic Messages API as cached system
context alongside your question, so Claude answers from the real numbers
rather than guessing. Chat history is kept client-side only (in the
browser tab) and resent each turn — closing/refreshing the page clears it;
the server itself doesn't store any chat state. Each question is a real API
call and incurs Anthropic's normal per-token cost on your key; prompt
caching keeps repeated questions in the same session cheaper by reusing the
cached data block instead of re-sending it at full price.

## Login / access control

The app is gated behind a single shared password — there's no per-user
accounts, just one password the whole team uses, the same way the rest of
this app's secrets (`ANTHROPIC_API_KEY`, `GMAIL_APP_PASSWORD`) are just one
value in `.env`. This matters most once the app is running somewhere public
(see "Deploying to Render" below) — without it, anyone with the URL could
view or edit real FIU revenue configs.

**Setup**: set two values in `.env`:

- `APP_PASSWORD` — the shared password. Leaving this unset disables the
  login gate entirely (no login screen, everything open) — that's the
  default so `npm start` on your own machine keeps working exactly as
  before with no extra step. Set it before deploying anywhere public.
- `SESSION_SECRET` — signs login sessions so they survive a server
  restart/redeploy. Generate one with `openssl rand -hex 32` (or any long
  random string) and set it once. Leaving it unset still works day to
  day — logins just all get invalidated every time the server restarts,
  since a fresh random secret is generated at each startup instead.

**How it works**: visiting the app while logged out redirects to `/login`,
which asks for the password. A **Stay logged in on this computer** checkbox
controls how long the login lasts — checked, it's remembered for 90 days
(a persistent cookie); unchecked, it's a plain browser-session cookie that
clears itself when the browser closes, backed by a 12-hour server-side
expiry either way. **Log out** in the top-right corner of the app clears
the session immediately. Wrong-password attempts are rate-limited per IP
(10 attempts per 15 minutes) to slow down brute-forcing the shared
password once the app is reachable from the open internet. None of this
applies to `/assets/*` (the logo/favicon) — those stay public so the login
page itself can render its branding before anyone's logged in.

## Deploying to Render

This needs a host that runs a persistent Node process — GitHub Pages (static
files only) won't work for this version. These steps are for
[Render](https://render.com), using the `render.yaml` Blueprint already in
this repo; Railway, Fly.io, or a plain VPS work too (see the note at the end
of this section) but need their own setup.

1. **Push this repo to GitHub** (Render deploys from a Git repo, not a
   local folder). If it isn't already a Git repo:
   ```
   git init
   git add .
   git commit -m "Initial commit"
   ```
   Then create an empty repo on GitHub and push:
   ```
   git remote add origin https://github.com/<you>/<repo-name>.git
   git branch -M main
   git push -u origin main
   ```
2. **Create a Render account** at [render.com](https://render.com) if you
   don't have one, and connect it to your GitHub account when prompted.
3. **New + → Blueprint**, and pick the repo you just pushed. Render reads
   `render.yaml` from the repo root and proposes a web service named
   `fiu-revenue-estimator` with a 1GB persistent disk already configured —
   review and click **Apply**.
4. **Fill in environment variables** — `render.yaml` lists which ones the
   service needs but deliberately leaves their values blank (so no secret
   ever ends up committed to the repo); Render's dashboard will prompt for
   each one before the first deploy, or you can set them under the
   service's **Environment** tab any time after:
   - `APP_PASSWORD` and `SESSION_SECRET` — **required**, see "Login /
     access control" above.
   - `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` — optional, for the chat
     feature. See "Chat with your data" below.
   - `GMAIL_USER` / `GMAIL_APP_PASSWORD` / `METABASE_EMAIL_SUBJECT` /
     `EMAIL_CHECK_CACHE_MINUTES` — optional, for auto-pulling counts from
     email. See "Auto-pull counts from email" above.
   - `DATA_DIR` is already set to `/var/data` by `render.yaml` — leave it
     as is, it's what points the app at the persistent disk instead of the
     repo's bundled `data/` folder. See the comment on `DATA_DIR` in
     `.env.example` and on `seedDataDirIfNeeded` in `lib/store.js` for how
     that disk gets its starting data.
5. **Deploy**. Render builds (`npm install`) and starts (`npm start`) the
   service, and gives you a public `https://fiu-revenue-estimator-xxxx.onrender.com`
   URL (renameable in the service's settings). Visiting it should land on
   the login screen from the section above.
6. **Every future push to `main` auto-redeploys** — Render watches the
   connected branch by default. The persistent disk means `data/*.json`
   (FIU Metadata, Yield & CMGR, uploaded historical actuals, saved
   snapshots) survives every redeploy; only what's in the repo itself
   (code, and the *starting* seed data) comes from Git.

**Free tier, no card on file**: the card prompt you hit on the Blueprint flow
comes from the persistent disk in `render.yaml`, not from Blueprints as
such — disks are a paid-plan-only feature on Render no matter how the
service gets created. Skip the disk and you can deploy manually for free:

1. Push to GitHub (same as step 1 above).
2. **New + → Web Service** (not Blueprint), and pick the repo.
3. Build Command `npm install`, Start Command `npm start`, Instance Type
   **Free**, Health Check Path `/healthz`.
4. Add the same environment variables as the Blueprint list above
   (`APP_PASSWORD`, `SESSION_SECRET`, and whichever optional ones you use)
   under the service's **Environment** tab — but this time leave `DATA_DIR`
   unset, so the app reads/writes `data/*.json` straight from the repo's
   bundled folder inside the container instead of a disk that doesn't
   exist on this plan.
5. Deploy.

The trade-off: any edits made through the app (FIU Metadata, Yield & CMGR,
uploaded historical actuals, a saved projection snapshot) live only in
that container's own filesystem. They survive the service sleeping and
waking back up, but get reset to whatever's checked into the repo every
time you push a new deploy. Free services also spin down after 15 minutes
with no traffic and take roughly a minute to wake back up on the next
visit. For a small internal tool that isn't redeployed often, that's
usually fine; if the team will be actively editing FIU Metadata/Yield &
CMGR day to day, the paid Starter plan + disk (the Blueprint path above)
is worth it so those edits don't quietly disappear on the next `git push`.

**Other hosts**: Railway and Fly.io work similarly (connect the repo, set
the start command to `npm start`, add a persistent volume, set the same
environment variables — skip `render.yaml`, which is Render-specific). A
plain VPS (a small droplet/EC2 instance) needs `git clone`, `npm install`,
a process manager like `pm2` or a `systemd` service, and nginx in front if
you want a custom domain/TLS — set `DATA_DIR` to wherever you want the data
to live on that machine's own disk (or leave it unset to use the repo's
`data/` folder directly, which is safe on a VPS since nothing wipes that
directory between runs the way a container redeploy would).

Whichever host you use, back up `data/*.json` (or wherever `DATA_DIR`
points) periodically — or point `lib/store.js` at a real database — since
that's where all of the app's configs and uploaded data live.

## API reference

- `GET/POST /api/fiu-metadata`, `PUT/DELETE /api/fiu-metadata/:fiuId`
- `GET/POST /api/yield-cmgr`, `PUT/DELETE /api/yield-cmgr/:fiuId`
- `POST /api/yield-cmgr/bulk` — JSON body `{ rows: [{ fiuId, yield?, cmgr?, sucYield?, sucCliffCmgr?, sucRecoveryCmgr? }, ...] }`. Only the fields present on each row are touched — useful for seeding just `sucYield`/`sucCliffCmgr`/`sucRecoveryCmgr` from an external list without disturbing existing `yield`/`cmgr` values.
- `POST /api/seed-from-master-data` — multipart `file`, seeds both configs
- `POST /api/compute` — multipart `file` + form fields `asOfDate`
  (`YYYY-MM-DD`, defaults to today), `fyStartMonth` (`1`–`12`, defaults to
  `4` for an April–March FY), `sucStartDate` (`YYYY-MM`, optional), and
  `scenarios` (comma-separated scenario keys, optional — see "What-if
  revenue scenarios" above). The response includes `scenariosApplied`, the
  list of keys actually recognized/turned on for that compute.
- `POST /api/compute-from-email` — JSON body `{ asOfDate?, fyStartMonth?, sucStartDate?, scenarios?, force? }` (same meaning/defaults as `/api/compute`'s form fields — `scenarios` here is also a comma-separated string; `force: true` bypasses the email check cache). Finds the latest matching email over IMAP (see "Auto-pull counts from email" above), computes from its CSV attachment exactly like `/api/compute`, and adds an `emailSource: { subject, date, filename, fetchedAt, fromCache }` field to the response. `400` if `GMAIL_USER`/`GMAIL_APP_PASSWORD`/`METABASE_EMAIL_SUBJECT` aren't all set, `404` if nothing matched, `502` on an IMAP connection/auth failure.
- `GET /api/scenarios` — returns `[{ key, label, description }, ...]`, the What-if scenario definitions the frontend builds its checkboxes from (see `SCENARIO_DEFINITIONS` in `lib/compute.js`).
- `POST /api/projection-snapshot` — multipart `file` + form fields `asOfDate`, `fyStartMonth` (same defaults as `/api/compute`; SUC is always forced off). Saves and returns `{ snapshotDate, asOfDate, fyStartMonth, months, totalsByMonth }`, overwriting any previous snapshot. **No longer called by the UI as of 2026-09-03** — the "Projected vs Actual Revenue" chart now tracks the live compute result instead (see "Projected vs Actual Revenue" above). Left in the backend for API compatibility in case anything else depends on it.
- `GET /api/projection-snapshot` — returns `{ snapshot }`, or `{ snapshot: null }` if none has been saved yet. Same status: no longer called by the UI, kept for compatibility.
- `GET /api/revenue-actuals?asOfDate=&fyStartMonth=` — returns `{ months, actualsByMonth }`, summed live from Historical Actuals for each FY month (`null` for a month with no historical rows yet). Both query params are optional with the same defaults as `/api/compute`.
- `GET /api/historical-actuals` — returns every recorded row: `[{ fiuId, month, revenue?, auCount?, dfCount?, billingModel?, billingYield? }, ...]`.
- `POST /api/historical-actuals` — JSON body `{ fiuId, month, revenue?, auCount?, dfCount?, billingModel?, billingYield? }` (`month` as `YYYY-MM`). Upserts one row, keyed by `fiuId` + `month` together (not `fiuId` alone) — a FIU can have one row per month.
- `DELETE /api/historical-actuals/:fiuId/:month` — removes one FIU's row for that month.
- `POST /api/historical-actuals/bulk` — multipart `file` + form field `month` (`YYYY-MM`, required). Same loose column matching as `/api/compute` (`FIU ID`, plus any of `Revenue`/`active_users`/`successful_data_fetches`) — needs at least one of the three value columns. Upserts by `fiuId` + `month`; rows/months not in the file are untouched. `billingModel`/`billingYield` are auto-filled from the current FIU Metadata/Yield & CMGR configs, for reference only. Returns `{ sheetUsed, ignoredSheets, columnsFound, month, created, updated, total, skipped }`.
- `POST /api/chat` — JSON body `{ messages: [{role, content}, ...], data: <a /api/compute response> }`. Returns `{ reply, model, usage }`, or `400`/`500` with `{ error }` (e.g. if `ANTHROPIC_API_KEY` isn't set on the server, or `data` is missing/empty). See "Chat with your data" above.
- `POST /api/login` — JSON body `{ password, remember? }`. Sets the `session` cookie and returns `{ ok: true }` on a correct password; `401` for a wrong one, `429` if that IP has made too many attempts recently, `400` if `APP_PASSWORD` isn't set. See "Login / access control" above.
- `POST /api/logout` — clears the `session` cookie, returns `{ ok: true }`.
- `GET /healthz` — always `200 { ok: true }`, unauthenticated, regardless of whether the login gate is configured. Meant for a host's health check, not for the app itself.
- Every other route requires a valid session once `APP_PASSWORD` is set — an unauthenticated request to any `/api/*` route above gets `401 { error: "Not logged in" }` instead of its usual response.

## Extending it

- `lib/compute.js` — billing-model classification, MTD→full-month
  projection, the FY month list, and CMGR-based projection.
- `lib/columns.js` — loose column-header matching (aliases), shared by the
  Master Data importer and the monthly counts upload.
- `lib/store.js` — the JSON-file config storage; replace this to move to a
  real database.
- `lib/chat.js` — the chat feature: `buildChatContext` (condenses a
  `/api/compute` response for the LLM) and `askChat` (the Anthropic API
  call). See "Chat with your data" above.
- `lib/mailIngest.js` — `fetchLatestCountsEmail`, the IMAP client that finds
  the newest matching Metabase email and pulls its CSV attachment. See
  "Auto-pull counts from email" above.
- `public/index.html` — the whole frontend (plain HTML/CSS/JS, no build
  step), talking to the API above.
- `public/login.html` — the login screen. Self-contained (its own inline
  CSS/JS), served directly by the `/login` route in `server.js` rather than
  through `express.static`, so it stays reachable even before anyone's
  logged in.
- `public/assets/` — the Finvu logo (`finvu-logo.png`) and the favicon
  files generated from it. Served unauthenticated regardless of the login
  gate (see the `/assets` route in `server.js`), since the login page needs
  to load them before login. Regenerate the favicons with Pillow if the
  logo ever changes — crop the icon mark (left of the wordmark) to a square
  canvas and export `.ico`/`.png` at a few sizes.
- The login gate itself (session signing/verification, rate limiting, the
  `requireAuth` middleware) lives inline near the top of `server.js` rather
  than its own file — it's small enough, and it needs to run before almost
  every other route.
- `render.yaml` — the Render Blueprint used in "Deploying to Render" above.
