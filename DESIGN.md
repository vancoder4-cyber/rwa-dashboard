# DESIGN.md — Avenir RWA Analytics Dashboard

> Design system for a real-world-asset perpetuals & spot arbitrage analytics dashboard.
> Aesthetic: **Linear meets Bloomberg** — institutional-grade data density with modern, refined minimalism.

---

## Visual Theme & Atmosphere

- **Mood**: Professional, quiet confidence. The dashboard conveys institutional trust — not flashy crypto aesthetics.
- **Density**: High. This is a data tool for analysts. Every pixel earns its place.
- **Contrast philosophy**: WCAG AA minimum. Primary data at full contrast; secondary metadata at 60% opacity equivalent.
- **Motion**: Restrained. Transitions ≤200ms ease-out. No bouncing, no spring physics. Micro-interactions only on hover/focus.
- **Depth model**: Subtle layering via 1px borders + controlled shadows. No heavy drop shadows.

---

## Color Palette & Roles

### Surfaces (Dark Theme)

| Token              | Hex       | Role                                    |
|--------------------|-----------|------------------------------------------|
| `--bg-base`        | `#0C0D10` | Page background — near-black, warm undertone |
| `--bg-raised`      | `#111318` | Raised surface (nav bar, footer)         |
| `--bg-card`        | `#161820` | Card/panel background                    |
| `--bg-card-hover`  | `#1C1F29` | Card hover state                         |
| `--bg-inset`       | `#1A1D26` | Inset areas (filter bar, sub-nav)        |
| `--bg-well`        | `#212433` | Metric wells, nested containers          |
| `--bg-well-hover`  | `#282C3D` | Well hover state                         |

### Borders

| Token              | Hex                    | Role                         |
|--------------------|------------------------|-------------------------------|
| `--border-subtle`  | `rgba(255,255,255,0.06)` | Default card/row borders     |
| `--border-default` | `rgba(255,255,255,0.09)` | Prominent borders            |
| `--border-hover`   | `rgba(255,255,255,0.14)` | Hover state borders          |
| `--border-focus`   | `rgba(99,142,255,0.4)`   | Focus rings                  |

### Text

| Token              | Hex       | Role                                     |
|--------------------|-----------|-------------------------------------------|
| `--text-primary`   | `#ECEEF3` | Primary text, headings, values           |
| `--text-secondary` | `#8B91A5` | Labels, metadata                         |
| `--text-tertiary`  | `#565C72` | Hints, timestamps, disabled              |
| `--text-inverted`  | `#0C0D10` | Text on bright backgrounds               |

### Accent (Avenir Blue)

| Token              | Hex       | Role                                     |
|--------------------|-----------|-------------------------------------------|
| `--accent`         | `#638EFF` | Primary interactive, active tab indicator |
| `--accent-hover`   | `#7DA2FF` | Hover state                              |
| `--accent-muted`   | `rgba(99,142,255,0.12)` | Soft background highlight     |
| `--accent-glow`    | `rgba(99,142,255,0.25)` | Focus glow / ring             |

### Semantic

| Token              | Hex       | Role                                     |
|--------------------|-----------|-------------------------------------------|
| `--positive`       | `#34D399` | Profit, up, good — softer emerald        |
| `--positive-muted` | `rgba(52,211,153,0.12)` | Badge/cell background        |
| `--negative`       | `#F87171` | Loss, down, bad — warm red               |
| `--negative-muted` | `rgba(248,113,113,0.12)` | Badge/cell background       |
| `--warning`        | `#FBBF24` | Caution, medium priority                 |
| `--warning-muted`  | `rgba(251,191,36,0.10)` | Badge background             |
| `--info`           | `#60A5FA` | Informational, links                     |
| `--info-muted`     | `rgba(96,165,250,0.10)` | Badge background             |

### Extended Palette (Charts & Categories)

| Token        | Hex       | Usage                  |
|-------------|-----------|------------------------|
| `--purple`  | `#A78BFA` | Equity category        |
| `--cyan`    | `#22D3EE` | ETF category           |
| `--pink`    | `#F472B6` | FX category            |
| `--orange`  | `#FB923C` | Commodity alt           |
| `--gold`    | `#D4A853` | Cross-analysis accent   |

### Venue Brand Colors

| Venue      | Color     | Dim (12% opacity)            |
|------------|-----------|-------------------------------|
| Trade.xyz  | `#C4875A` | `rgba(196,135,90,0.12)`       |
| Bitget     | `#34D399` | `rgba(52,211,153,0.12)`       |
| Gate.io    | `#638EFF` | `rgba(99,142,255,0.12)`       |
| Binance    | `#F0B90B` | `rgba(240,185,11,0.12)`       |
| Kraken     | `#A78BFA` | `rgba(167,139,250,0.12)`      |
| OKX        | `#111827` | `rgba(17,24,39,0.12)`         |
| Bybit      | `#FB923C` | `rgba(251,147,60,0.12)`       |
| Lighter    | `#34D399` | `rgba(52,211,153,0.12)`       |
| Vest       | `#F472B6` | `rgba(244,114,182,0.12)`      |

---

## Typography

| Role            | Family                         | Size  | Weight | Tracking   |
|-----------------|--------------------------------|-------|--------|------------|
| Logo mark       | Inter                          | 20px  | 800    | -0.5px     |
| Page title      | Inter                          | 15px  | 700    | 0          |
| Section heading | Inter                          | 13px  | 700    | 0          |
| Label / Caption | Inter                          | 11px  | 600    | 0.5px      |
| Body            | Inter                          | 13px  | 500    | 0          |
| Code / Numbers  | JetBrains Mono                 | 13px  | 600    | -0.3px     |
| KPI large       | JetBrains Mono                 | 24px  | 700    | -0.5px     |
| Badge / Tag     | Inter                          | 10px  | 700    | 0.3px      |
| Tooltip         | Inter                          | 11px  | 400    | 0          |

---

## Spacing Scale

Base unit: 4px

| Token  | Value | Usage                      |
|--------|-------|----------------------------|
| `xs`   | 4px   | Tight gaps in badges       |
| `sm`   | 8px   | Inter-element spacing      |
| `md`   | 12px  | Card padding, grid gaps    |
| `lg`   | 16px  | Section padding            |
| `xl`   | 20px  | Major section padding      |
| `2xl`  | 24px  | Page margin, header padding|
| `3xl`  | 32px  | Hero spacing               |

---

## Radius

| Token         | Value | Usage                        |
|---------------|-------|-------------------------------|
| `--r-sm`      | 4px   | Badges, tags, tiny elements   |
| `--r-md`      | 8px   | Inputs, small cards           |
| `--r-lg`      | 12px  | Cards, panels                 |
| `--r-xl`      | 16px  | Modal, large panels           |
| `--r-full`    | 9999px| Pills, status indicators      |

---

## Shadows

| Token         | Value                                              | Usage           |
|---------------|----------------------------------------------------|-----------------|
| `--shadow-xs` | `0 1px 2px rgba(0,0,0,0.3)`                       | Subtle lift     |
| `--shadow-sm` | `0 2px 6px rgba(0,0,0,0.25)`                      | Cards hover     |
| `--shadow-md` | `0 4px 16px rgba(0,0,0,0.3)`                      | Dropdowns       |
| `--shadow-lg` | `0 12px 32px rgba(0,0,0,0.4)`                     | Modals          |

---

## Component Patterns

### KPI Card
- Background: `--bg-card` with `--border-subtle`
- Hover: border transitions to `--border-hover`, subtle `--shadow-xs`
- Top-left: Small label in `--text-tertiary`, uppercase, 10px
- Center: Large value in JetBrains Mono 24px `--text-primary`
- Bottom: Sub-text in `--text-tertiary` 11px
- Optional: Left border accent — 2px `--accent` for "primary" KPIs

### Data Table
- Header: `--bg-inset`, uppercase 10px `--text-tertiary`, no bold borders
- Rows: Alternating `transparent` / `rgba(255,255,255,0.015)`
- Row hover: `--bg-card-hover` with left 2px `--accent` indicator
- Cell font: JetBrains Mono 13px for numbers, Inter for text
- Sort indicator: Active column header in `--accent`
- Row dividers: `--border-subtle` (very faint)

### Navigation Tabs
- Inactive: `--text-tertiary` 13px weight-600
- Hover: `--text-secondary`
- Active: `--text-primary` with 2px bottom indicator in `--accent`
- No background change — only text color + indicator

### Filter Chips
- Default: transparent bg, `--border-subtle` border, `--text-tertiary`
- Hover: `--bg-well` background, `--text-secondary`
- Active: `--accent-muted` bg, `--accent` text, `--accent` border at 30%
- Category and Market are separate filter dimensions. `All Markets / US-listed` is available in Perpetual venue tables, Perpetual By Asset, Spot arbitrage, Spot All Assets and Spot venue tables; both dimensions combine with AND and persist while switching Spot sub-views.

### Badges / Tags
- Category: Respective color at 12% opacity bg, full color text
- Change: Green/Red muted bg + matching text
- Venue: Venue brand color at 12% bg + full color text
- Size: 10px font, 2px 8px padding, `--r-sm` radius

### Listing identity & provenance
- The primary row identity is the canonical underlying, while venue symbol and product type remain visible as listing metadata.
- Cross-venue and cross-section joins use `category:canonicalUnderlying`; a same-ticker Equity, ETF, Commodity, or Crypto row never merges by spelling alone. Venue-scoped aliases are applied only after that venue's official RWA catalog has verified the product.
- One venue dot represents one venue, not one contract. If OKX supplies both SWAP and X-Perp for the same underlying, the aggregate row counts OKX once but the expanded row and Asset Intelligence Drawer show both independent listings with `SWAP` / `X-PERP` labels.
- Coverage and numeric fields use only the canonical `Full / Partial / Estimated / Unavailable` states. Missing values render as an em dash plus status, never numeric zero.
- OKX derivative USD volume derived from base quantity × price and generic account-tier fee defaults carry an `Estimated` badge. Unsupported fees are `Unavailable`; neither may visually resemble an official Full value.
- The Top 30 loading/provenance line names every participating venue. A 30-day value is Full only with 30 confirmed daily quote-volume bars. trade.xyz derives quote notional as hourly base volume × close and therefore remains Estimated even with all 720 completed hours; partial history and `24h×30` fallbacks remain visually distinguishable.
- `US-listed / 美股` means the resolved Equity/ETF underlying is confirmed in the official Nasdaq Trader U.S. listing directories. ADR and home-market/exposure tags remain additive. Aggregated rows display the union of tags from every listing, never the first venue's tags.
- Missing numeric fields remain null through aggregation, sorting and Spot↔Perp joins. A visually rendered zero is always a reported/calculated zero, never a placeholder for missing data.
- Aggregate cells expose coverage status against the current listing universe; a subtotal with one or more missing listing inputs is Partial. Stale last-good rows remain diagnosable but are excluded from live opportunity rankings.
- Freshness is recomputed from each venue's `lastSuccessAt`, not trusted as a static label. Perpetual and Spot hard-expire at twice their normal refresh cadence; missing, invalid, future, or boundary timestamps fail closed. Funding rankings, heatmaps, alerts, basis and net-APR routes use only fresh rows.
- Top 30 Full volume means every expected current contract has the complete confirmed history window and a directly comparable quote-volume field. Missing component contributions stay unavailable rather than rendering as zero. The merged gold row and Asset Intelligence Drawer share the same audited `commodity:XAU` family identity.

### Modal
- Overlay: `rgba(0,0,0,0.7)` + `backdrop-filter: blur(8px)`
- Box: `--bg-card` with `--border-default` + `--shadow-lg`
- Radius: `--r-xl`
- Entry: translateY(8px) + opacity 0 → 0 + 1, 200ms ease-out

### Heatmap Cell
- Positive range: `--positive` at 10%-60% opacity based on magnitude
- Negative range: `--negative` at 10%-60% opacity based on magnitude
- Neutral: `--bg-well`
- N/A: `--bg-inset` with `--text-tertiary`
- Hover: scale(1.03), `--shadow-sm`

---

## Layout Rules

- Max content width: none (full viewport)
- Page horizontal padding: 24px
- Header height: 52px, sticky, z-index 100
- Grid gaps: 12px between cards
- KPI row: CSS Grid, 5 columns (4 on tablet, 2 on mobile)
- Venue card grid: auto-fit minmax(480px, 1fr)
- Table min-width: 1080px with horizontal scroll wrapper

---

## Interaction States

| State    | Duration | Easing       | Properties                    |
|----------|----------|--------------|-------------------------------|
| Hover    | 150ms    | ease-out     | background, border-color, color |
| Focus    | 0ms      | instant      | box-shadow (ring)             |
| Active   | 50ms     | ease-out     | transform scale(0.98)         |
| Expand   | 200ms    | ease-out     | height, opacity               |
| Modal    | 200ms    | ease-out     | opacity, transform            |

---

## Responsive Breakpoints

| Name    | Width   | Adjustments                              |
|---------|---------|-------------------------------------------|
| Desktop | >1280px | Full layout, 5-col KPI                   |
| Tablet  | 960px   | 2-col KPI, 1-col venue cards             |
| Mobile  | 640px   | 1-col everything, reduced padding 16px   |
