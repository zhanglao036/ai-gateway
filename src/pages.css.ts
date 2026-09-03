export const CSS_CONTENT = `
/* 中文说明：方案 A「Cloud Workbench」统一首页、登录页和管理页的设计语言；不涉及后端逻辑。 */
/* Hallmark · genre: modern-minimal · macrostructure: Workbench · design-system: design.md · designed-as-app
 * Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V5
 */
:root {
  --color-paper: oklch(98.5% 0.004 250);
  --color-paper-a: oklch(98.5% 0.004 250 / .94);
  --color-paper-2: oklch(96.7% 0.006 250);
  --color-paper-3: oklch(94.8% 0.008 250);
  --color-ink: oklch(22% 0.020 258);
  --color-ink-2: oklch(34% 0.018 257);
  --color-muted: oklch(49% 0.016 255);
  --color-rule: oklch(89% 0.010 252);
  --color-rule-2: oklch(82% 0.014 252);
  --color-accent: oklch(52% 0.205 256);
  --color-accent-hover: oklch(46% 0.195 256);
  --color-accent-soft: oklch(94% 0.030 256);
  --color-accent-ink: oklch(99% 0.003 250);
  --color-focus: oklch(44% 0.180 256);
  --color-success: oklch(45% 0.120 158);
  --color-success-soft: oklch(95% 0.025 158);
  --color-success-ink: oklch(34% 0.092 158);
  --color-danger: oklch(50% 0.185 25);
  --color-danger-hover: oklch(45% 0.175 25);
  --color-danger-soft: oklch(96% 0.022 25);
  --color-danger-ink: oklch(38% 0.145 25);
  --color-graphite: oklch(22% 0.016 260);
  --color-graphite-2: oklch(28% 0.018 260);
  --color-graphite-rule: oklch(38% 0.020 258);
  --color-graphite-ink: oklch(92% 0.010 250);
  --color-overlay: oklch(18% 0.020 258 / .48);
  --shadow-panel: 0 18px 48px oklch(20% 0.020 258 / .10);
  --shadow-float: 0 8px 24px oklch(20% 0.020 258 / .12);

  --font-display: 'Space Grotesk', 'SF Pro Display', sans-serif;
  --font-body: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-mono: 'JetBrains Mono', 'SFMono-Regular', Consolas, monospace;

  --space-3xs: .25rem;
  --space-2xs: .5rem;
  --space-xs: .75rem;
  --space-sm: 1rem;
  --space-md: 1.5rem;
  --space-lg: 2rem;
  --space-xl: 3rem;
  --space-2xl: 4rem;
  --space-3xl: 6rem;
  --space-4xl: 8rem;

  --text-xs: .75rem;
  --text-sm: .875rem;
  --text-md: 1rem;
  --text-lg: 1.25rem;
  --text-xl: 1.75rem;
  --text-2xl: clamp(2.25rem, 5vw, 4.5rem);

  --radius-control: .375rem;
  --radius-panel: .625rem;
  --radius-round: 999px;
  --control-h: 2.75rem;
  --control-h-sm: 2rem;
  --shell: 74rem;
  --ease-out: cubic-bezier(.16, 1, .3, 1);
  --dur-fast: 160ms;
  --dur-panel: 260ms;

  /* compatibility aliases for existing management scripts */
  --c-primary: var(--color-accent);
  --c-primary-hover: var(--color-accent-hover);
  --c-primary-glow: var(--color-accent-soft);
  --c-text: var(--color-ink-2);
  --c-text-dark: var(--color-ink);
  --c-text-secondary: var(--color-ink-2);
  --c-text-muted: var(--color-muted);
  --c-text-light: var(--color-muted);
  --c-bg: var(--color-paper-2);
  --c-bg-white: var(--color-paper);
  --c-bg-light: var(--color-paper-2);
  --c-bg-alt: var(--color-paper-2);
  --c-border: var(--color-rule);
  --c-border-dark: var(--color-rule-2);
  --c-success: var(--color-success);
  --c-success-bg: var(--color-success-soft);
  --c-success-text: var(--color-success-ink);
  --c-danger: var(--color-danger);
  --c-danger-bg: var(--color-danger-soft);
  --c-danger-text: var(--color-danger-ink);
  --c-info-bg: var(--color-accent-soft);
  --c-info-text: var(--color-focus);
  --c-overlay: var(--color-overlay);
}

*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; min-width: 0; overflow-x: clip; scroll-behavior: smooth; }
body {
  min-height: 100dvh;
  background: var(--color-paper-2);
  color: var(--color-ink-2);
  font-family: var(--font-body);
  font-size: var(--text-sm);
  line-height: 1.6;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
}
button, input, textarea, select { font: inherit; }
button, a, input, select, textarea { -webkit-tap-highlight-color: transparent; }
a { color: inherit; }
h1, h2, h3, p, figure, dl, dd { margin: 0; }
h1, h2, h3 { color: var(--color-ink); font-family: var(--font-display); font-style: normal; font-weight: 600; letter-spacing: -.025em; line-height: 1.12; overflow-wrap: anywhere; min-width: 0; }
code, pre { font-family: var(--font-mono); }
fieldset { min-width: 0; }
html:focus-within { scroll-behavior: smooth; }
:target { scroll-margin-top: var(--space-lg); }
:focus { outline: 0; }
:focus-visible { outline: .125rem solid var(--color-focus); outline-offset: .125rem; }
::selection { background: var(--color-accent-soft); color: var(--color-ink); }

.shell { width: min(100% - calc(var(--space-sm) * 2), var(--shell)); margin-inline: auto; }
.site-page { display: flex; min-height: 100dvh; flex-direction: column; }
.site-page > main { flex: 1; }
.hd { display: none !important; }
.sr-only { position: absolute; width: .0625rem; height: .0625rem; padding: 0; margin: -.0625rem; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
.sr-status { min-height: 1lh; color: var(--color-muted); font-size: var(--text-xs); }

/* shared navigation */
.topbar { position: sticky; inset-block-start: 0; z-index: 100; min-height: 4rem; border-block-end: .0625rem solid var(--color-rule); background: var(--color-paper-a); color: var(--color-ink); backdrop-filter: blur(.75rem); }
.topbar__inner { min-height: 4rem; display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); }
.brand { min-width: 0; display: inline-flex; align-items: center; gap: var(--space-2xs); color: var(--color-ink); text-decoration: none; white-space: nowrap; }
.brand__mark { width: 2rem; height: 2rem; flex: 0 0 auto; display: grid; place-items: center; border: .0625rem solid var(--color-rule-2); border-radius: var(--radius-control); background: var(--color-paper); color: var(--color-accent); }
.brand__name, .brand strong { font-family: var(--font-display); font-size: var(--text-md); font-weight: 600; letter-spacing: -.02em; }
.brand__descriptor, .brand small { color: var(--color-muted); font-family: var(--font-mono); font-size: .625rem; font-weight: 500; letter-spacing: .08em; }
.topbar__actions { display: flex; align-items: center; gap: var(--space-2xs); }

/* buttons and controls */
.btn, .icon-btn, .model-token, .password-toggle, .admin-nav__link, .ps {
  border: .0625rem solid transparent;
  border-radius: var(--radius-control);
  cursor: pointer;
  text-decoration: none;
  white-space: nowrap;
  transition: background-color var(--dur-fast) ease, border-color var(--dur-fast) ease, color var(--dur-fast) ease, transform var(--dur-fast) ease;
}
.btn { min-height: var(--control-h); padding-inline: var(--space-sm); display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2xs); font-size: var(--text-sm); font-weight: 600; line-height: 1; }
.btn-p { border-color: var(--color-accent); background: var(--color-accent); color: var(--color-accent-ink); }
.btn-s { border-color: var(--color-rule-2); background: var(--color-paper); color: var(--color-ink-2); }
.btn-gh { border-color: transparent; background: transparent; color: var(--color-muted); }
.btn-g { border-color: var(--color-success-soft); background: var(--color-success-soft); color: var(--color-success-ink); }
.btn-d { border-color: var(--color-danger-soft); background: var(--color-danger-soft); color: var(--color-danger-ink); }
.btn-xs { min-height: var(--control-h); padding-inline: var(--space-xs); font-size: var(--text-md); }
.icon-btn, .password-toggle { width: var(--control-h-sm); height: var(--control-h-sm); flex: 0 0 var(--control-h-sm); display: inline-grid; place-items: center; border-color: transparent; background: transparent; color: var(--color-muted); }
.icon-btn span { font-family: var(--font-body); font-size: var(--text-xs); }
.copy-control[data-state='success'] { border-color: var(--color-success); color: var(--color-success-ink); }
.copy-control[data-state='error'] { border-color: var(--color-danger); color: var(--color-danger-ink); }
.btn:active, .icon-btn:active, .model-token:active, .password-toggle:active, .ps:active { transform: translateY(.0625rem); }
.btn:disabled, .btn[aria-disabled='true'], .icon-btn:disabled, input:disabled, select:disabled { opacity: .55; cursor: not-allowed; }
.btn[data-state='loading'] .button-label { display: none; }
.btn:not([data-state='loading']) .button-loading { display: none; }
.btn[data-state='success'] { border-color: var(--color-success); background: var(--color-success); color: var(--color-paper); }
.button-loading { display: inline-flex; align-items: center; gap: var(--space-2xs); }

/* form controls */
input, textarea, select {
  width: 100%; height: var(--control-h); padding-inline: var(--space-xs); border: .0625rem solid var(--color-rule-2); border-radius: var(--radius-control); outline: .125rem solid transparent; outline-offset: .0625rem; background: var(--color-paper); color: var(--color-ink); transition: background-color var(--dur-fast) ease, border-color var(--dur-fast) ease;
}
input::placeholder, textarea::placeholder { color: var(--color-muted); opacity: .82; }
input:focus-visible, textarea:focus-visible, select:focus-visible { border-color: var(--color-ink-2); outline: .125rem solid var(--color-focus); outline-offset: .0625rem; }
input[aria-invalid='true'], textarea[aria-invalid='true'], select[aria-invalid='true'] { border-color: var(--color-danger); background: var(--color-danger-soft); }
textarea { min-height: 6rem; padding-block: var(--space-xs); resize: vertical; }
label, legend { color: var(--color-ink-2); font-size: var(--text-xs); font-weight: 600; }
.fg { min-width: 0; margin-block-end: var(--space-sm); }
.fg > label { display: block; margin-block-end: var(--space-2xs); }
.form-helper { min-height: 1lh; margin-block-start: var(--space-3xs); color: var(--color-muted); font-size: var(--text-xs); }
.input-wrap { position: relative; }
.input-wrap > i { position: absolute; inset-inline-start: var(--space-xs); inset-block-start: 50%; z-index: 1; color: var(--color-muted); transform: translateY(-50%); }
.input-wrap input { padding-inline-start: var(--space-xl); padding-inline-end: var(--space-xl); }
.password-toggle { position: absolute; inset-inline-end: 0; inset-block-start: 0; }
.select-sm { height: var(--control-h); }
.fr, .fr3 { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0 var(--space-sm); }
.form-group { margin: 0 0 var(--space-md); padding: var(--space-sm); border: .0625rem solid var(--color-rule); border-radius: var(--radius-control); }
.form-group legend { padding-inline: var(--space-2xs); }
.field-row { min-width: 0; flex-wrap: nowrap; }
.field-row input { min-width: 0; }
/* 纯图标按钮相邻时收紧间距（负外边距抵消 .fc 的 gap） */
.fc > .icon-btn + .icon-btn { margin-inline-start: calc(var(--space-3xs) - var(--space-2xs)); }

/* switch */
.tg { position: relative; display: inline-block; width: 2.5rem; height: var(--control-h); flex: 0 0 2.5rem; margin: 0; }
.tg input { position: absolute; opacity: 0; width: .0625rem; height: .0625rem; }
.tg .sl { position: absolute; inset-inline: 0; inset-block-start: .8125rem; height: 1.125rem; border-radius: var(--radius-round); background: var(--color-rule-2); cursor: pointer; transition: background-color var(--dur-fast) ease; }
.tg .sl::before { content: ''; position: absolute; width: .75rem; height: .75rem; inset-inline-start: .1875rem; inset-block-start: .1875rem; border-radius: 50%; background: var(--color-paper); box-shadow: 0 .0625rem .125rem var(--color-overlay); transition: transform var(--dur-fast) var(--ease-out); }
.tg input:checked + .sl { background: var(--color-accent); }
.tg input:checked + .sl::before { transform: translateX(1.375rem); }
.tg input:focus-visible + .sl { outline: .125rem solid var(--color-focus); outline-offset: .125rem; }
.tg input:disabled + .sl { opacity: .55; cursor: not-allowed; }

/* home workbench */
.home-page { background: var(--color-paper); }
.home-hero { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-xl); padding-block: var(--space-2xl); }
.home-hero__copy { align-self: center; min-width: 0; }
.eyebrow { margin-block-end: var(--space-sm); display: flex; align-items: center; gap: var(--space-2xs); color: var(--color-muted); font-family: var(--font-mono); font-size: .6875rem; font-weight: 600; letter-spacing: .08em; }
.eyebrow > span { width: .75rem; height: .125rem; background: var(--color-accent); }
.home-hero h1 { max-width: 12ch; font-size: var(--text-2xl); }
.home-hero__lede { max-width: 60ch; margin-block-start: var(--space-md); color: var(--color-muted); font-size: var(--text-md); }
.endpoint-box { max-width: 40rem; margin-block-start: var(--space-lg); display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; border: .0625rem solid var(--color-rule-2); border-radius: var(--radius-control); background: var(--color-paper-2); }
.endpoint-box__label { grid-column: 1 / -1; padding: var(--space-2xs) var(--space-xs) 0; color: var(--color-muted); font-family: var(--font-mono); font-size: .625rem; font-weight: 600; letter-spacing: .08em; }
.endpoint-box code { min-width: 0; padding: var(--space-2xs) var(--space-xs) var(--space-xs); overflow: hidden; color: var(--color-ink); font-size: var(--text-xs); text-overflow: ellipsis; white-space: nowrap; }
.endpoint-box .icon-btn { width: auto; padding-inline: var(--space-sm); display: flex; gap: var(--space-2xs); border-inline-start-color: var(--color-rule); border-radius: 0; }
.request-panel { min-width: 0; overflow: clip; border: .0625rem solid var(--color-graphite-rule); border-radius: var(--radius-panel); background: var(--color-graphite); color: var(--color-graphite-ink); box-shadow: var(--shadow-panel); }
.request-panel figcaption, .request-panel__foot { min-height: 3rem; padding-inline: var(--space-sm); display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); border-block-end: .0625rem solid var(--color-graphite-rule); color: var(--color-graphite-ink); font-family: var(--font-mono); font-size: .625rem; letter-spacing: .04em; }
.protocol-state { display: inline-flex; align-items: center; gap: var(--space-2xs); color: var(--color-graphite-ink); white-space: nowrap; }
.protocol-state i { width: .4375rem; height: .4375rem; border-radius: 50%; background: var(--color-success); }
.request-panel pre { margin: 0; min-height: 18rem; padding: var(--space-md); overflow: auto; background: var(--color-graphite); color: var(--color-graphite-ink); font-size: clamp(.6875rem, 2vw, .8125rem); line-height: 1.8; }
.request-panel pre code { white-space: pre; }
.syntax-command, .syntax-key { color: oklch(75% 0.130 256); }
.syntax-string { color: oklch(83% 0.060 154); }
.request-panel__foot { border-block-start: .0625rem solid var(--color-graphite-rule); border-block-end: 0; color: oklch(72% 0.012 250); }
.request-panel__foot code { color: var(--color-graphite-ink); }
.metrics-strip { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); border-block: .0625rem solid var(--color-rule); }
.metric { min-width: 0; padding-block: var(--space-md); display: flex; flex-direction: column; gap: var(--space-3xs); border-inline-end: .0625rem solid var(--color-rule); }
.metric:nth-child(even) { border-inline-end: 0; }
.metric:nth-child(n+3) { border-block-start: .0625rem solid var(--color-rule); }
.metric__value { color: var(--color-ink); font-family: var(--font-display); font-size: var(--text-xl); font-weight: 600; line-height: 1; }
.metric__label { color: var(--color-muted); font-size: var(--text-xs); }
.directory { padding-block: var(--space-2xl) var(--space-3xl); }
.directory-toolbar { margin-block-end: var(--space-lg); display: flex; flex-direction: column; gap: var(--space-md); }
.directory-header h2 { font-size: var(--text-xl); font-weight: 700; color: var(--color-ink); }
.directory-header p { color: var(--color-muted); font-size: var(--text-xs); margin-block-start: var(--space-3xs); }
.directory-search-bar { width: 100%; }
.filter-chips { display: flex; flex-wrap: wrap; gap: var(--space-2xs); align-items: center; }
.filter-chip { display: inline-flex; align-items: center; gap: var(--space-2xs); padding: 0.375rem 0.75rem; border-radius: var(--radius-round); border: .0625rem solid var(--color-rule-2); background: var(--color-paper-2); color: var(--color-ink-2); font-size: var(--text-xs); font-weight: 500; cursor: pointer; transition: all var(--dur-fast) ease; }
.filter-chip:hover { border-color: var(--color-rule-3, #cbd5e1); background: var(--color-paper-3); }
.filter-chip.is-active { border-color: var(--color-focus, #2563eb); background: var(--color-accent-soft, #eff6ff); color: var(--color-focus, #2563eb); font-weight: 600; }

.section-heading { margin-block-end: var(--space-lg); display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-sm); align-items: end; }
.section-heading h2 { font-size: var(--text-xl); }
.section-heading p { max-width: 65ch; margin-block-start: var(--space-2xs); color: var(--color-muted); }
.search-field { position: relative; width: 100%; }
.search-field > i { position: absolute; inset-inline-start: var(--space-xs); inset-block-start: 50%; color: var(--color-muted); transform: translateY(-50%); }
.search-field input { padding-inline-start: var(--space-lg); }

.provider-index { display: flex; flex-direction: column; gap: var(--space-md); }
.provider-card { background: var(--color-paper, #ffffff); border: .0625rem solid var(--color-rule-2, #e2e8f0); border-radius: var(--radius-panel, 12px); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03); overflow: hidden; transition: border-color var(--dur-fast) ease; }
.provider-card:hover { border-color: var(--color-rule-3, #cbd5e1); }
.provider-card__header { padding: 0.875rem 1.125rem; background: var(--color-paper-2, #f8fafc); border-block-end: .0625rem solid var(--color-rule-2, #e2e8f0); display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
.provider-card__identity { display: flex; align-items: center; gap: 0.75rem; }
.provider-card__title { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.provider-card__title h3 { font-size: var(--text-md); font-weight: 700; color: var(--color-ink); margin: 0; }
.provider-id-badge { font-size: var(--text-xs); padding: 1px 6px; border-radius: 4px; background: #f1f5f9; color: #475569; border: 1px solid #e2e8f0; font-family: var(--font-mono, monospace); }
.provider-card__meta { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin-block-start: 0.25rem; font-size: var(--text-xs); color: var(--color-muted); }
.meta-tag { display: inline-flex; align-items: center; gap: 0.25rem; font-size: var(--text-xs); color: var(--color-muted); }
.meta-tag--ok { color: #16a34a; font-weight: 600; }
.meta-tag--cd { color: #d97706; font-weight: 600; }
.meta-tag--err { color: #dc2626; font-weight: 600; }

.provider-card__body { padding: 1rem 1.125rem; }

/* Models Grid */
.models-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 0.625rem; }

/* Model Card */
.model-card { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.5rem 0.75rem; border: .0625rem solid var(--color-rule-2, #e2e8f0); border-radius: 8px; background: var(--color-paper, #ffffff); cursor: pointer; transition: all var(--dur-fast) ease; min-height: 40px; }
.model-card:hover { border-color: var(--color-focus, #3b82f6); background: var(--color-paper-2, #f8fafc); box-shadow: 0 2px 6px rgba(0, 0, 0, 0.04); }
.model-card[data-state="success"] { border-color: #22c55e !important; background: #f0fdf4 !important; }
.model-card__info { display: flex; align-items: center; gap: 0.5rem; min-width: 0; flex: 1; }
.model-card__name { font-family: var(--font-mono, monospace); font-size: 0.8125rem; font-weight: 600; color: var(--color-ink, #0f172a); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-card__copy-btn { border: none; background: transparent; color: var(--color-muted, #94a3b8); padding: 4px; font-size: 0.8125rem; cursor: pointer; flex-shrink: 0; transition: color var(--dur-fast) ease; }
.model-card:hover .model-card__copy-btn { color: var(--color-focus, #2563eb); }

/* Model Badges */
.m-badge { display: inline-flex; align-items: center; gap: 0.2rem; font-size: 0.6875rem; padding: 1px 5px; border-radius: 4px; font-weight: 600; white-space: nowrap; flex-shrink: 0; }
.m-badge--ok { background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0; }
.m-badge--cd { background: #fefce8; color: #ca8a04; border: 1px solid #fef08a; }
.m-badge--err { background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; }

/* Collapsed Models Visibility */
.model-card.is-collapsed { display: none !important; }
.provider-card.is-expanded .model-card.is-collapsed:not(.hd),
.provider-card.is-searching .model-card.is-collapsed:not(.hd) { display: flex !important; }
.provider-card.is-searching .btn-expand-models { display: none !important; }

.provider-card__footer { margin-block-start: 0.875rem; text-align: center; }
.btn-expand-models { display: inline-flex; align-items: center; gap: 0.375rem; padding: 0.375rem 1rem; font-size: 0.8125rem; font-weight: 600; color: var(--color-focus, #2563eb); background: var(--color-paper-2, #f8fafc); border: .0625rem solid var(--color-rule-2, #e2e8f0); border-radius: 6px; cursor: pointer; transition: all var(--dur-fast) ease; }
.btn-expand-models:hover { background: var(--color-accent-soft, #eff6ff); border-color: var(--color-focus, #2563eb); }

.provider-row { min-width: 0; padding-block: var(--space-md); display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-md); align-items: start; border-block-end: .0625rem solid var(--color-rule); }
.provider-row__identity { min-width: 0; display: flex; align-items: center; gap: var(--space-xs); }
.provider-row__mark, .provider-avatar { width: 2.5rem; height: 2.5rem; flex: 0 0 auto; display: grid; place-items: center; border: .0625rem solid var(--color-rule-2); border-radius: var(--radius-control); background: var(--color-paper-2); color: var(--color-ink); font-family: var(--font-display); font-weight: 600; }
.provider-row h3 { font-size: var(--text-md); }
.provider-row__identity p { margin-block-start: var(--space-3xs); display: flex; flex-wrap: wrap; gap: var(--space-2xs); color: var(--color-muted); font-size: var(--text-xs); }
.provider-row__identity code { color: var(--color-ink-2); }
.provider-row__models { min-width: 0; display: flex; flex-wrap: wrap; gap: var(--space-2xs); }
.model-token { max-width: 100%; min-height: var(--control-h); padding-inline: var(--space-xs); display: inline-flex; align-items: center; gap: var(--space-2xs); border-color: var(--color-rule); background: var(--color-paper-2); color: var(--color-ink-2); }
.model-token code { overflow: hidden; font-size: var(--text-xs); text-overflow: ellipsis; white-space: nowrap; }
.model-token i { color: var(--color-muted); }
.status-badge, .bd, .protocol-chip, .status-dot { display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2xs); width: max-content; min-height: 1.75rem; padding-inline: var(--space-xs); border-radius: var(--radius-round); font-size: var(--text-xs); font-weight: 600; white-space: nowrap; }
.status-badge i, .status-dot i { width: .4375rem; height: .4375rem; border-radius: 50%; background: currentColor; }
.status-badge--on, .bd-on, .status-dot--online { background: var(--color-success-soft); color: var(--color-success-ink); }
.bd-off { background: var(--color-paper-3); color: var(--color-muted); }
.bd-info, .protocol-chip { background: var(--color-accent-soft); color: var(--color-focus); }
/* 删除类徽标按钮：形状同 .bd 胶囊，颜色保持危险态 */
.bd-del { border: .0625rem solid transparent; background: var(--color-danger-soft); color: var(--color-danger-ink); font-family: inherit; cursor: pointer; transition: background-color var(--dur-fast) ease, color var(--dur-fast) ease; }
.bd-del:hover { background: var(--color-danger); color: var(--color-paper); }
.empty-inline { color: var(--color-muted); font-size: var(--text-xs); }
.empty-state { padding: var(--space-xl) var(--space-sm); display: flex; flex-direction: column; align-items: center; gap: var(--space-xs); border: .0625rem dashed var(--color-rule-2); border-radius: var(--radius-panel); background: var(--color-paper-2); color: var(--color-muted); text-align: center; }
.empty-state > i { font-size: var(--text-lg); color: var(--color-muted); }
.empty-state h3 { font-size: var(--text-md); }
.empty-state p { max-width: 55ch; }
.site-footer { border-block-start: .0625rem solid var(--color-rule); background: var(--color-paper-2); color: var(--color-muted); }
.admin-main > .site-footer { margin-block-start: auto; }
.site-footer__inner { padding-block: var(--space-md); display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-2xs); font-size: var(--text-xs); }
.site-footer a { text-underline-offset: .125rem; }
.site-footer__link { color: inherit; text-decoration: none; }

/* authentication split */
.auth-page { background: var(--color-paper); }
.auth-shell { width: min(100%, var(--shell)); min-height: calc(100dvh - 4rem); margin-inline: auto; display: grid; grid-template-columns: minmax(0, 1fr); }
.auth-context, .auth-form-wrap { min-width: 0; padding: var(--space-xl) var(--space-sm); }
.auth-context { display: flex; flex-direction: column; justify-content: center; border-block-end: .0625rem solid var(--color-rule); background: var(--color-paper-2); color: var(--color-ink-2); }
.auth-context h1 { max-width: 11ch; font-size: clamp(2.25rem, 6vw, 4rem); }
.auth-context > p:not(.eyebrow) { max-width: 58ch; margin-block-start: var(--space-md); color: var(--color-muted); font-size: var(--text-md); }
.auth-facts { margin-block-start: var(--space-xl); border-block-start: .0625rem solid var(--color-rule); }
.auth-facts > div { padding-block: var(--space-sm); display: grid; grid-template-columns: minmax(7rem, .7fr) minmax(0, 1.3fr); gap: var(--space-sm); border-block-end: .0625rem solid var(--color-rule); }
.auth-facts dt { color: var(--color-muted); font-size: var(--text-xs); }
.auth-facts dd { min-width: 0; color: var(--color-ink); font-size: var(--text-xs); overflow-wrap: anywhere; }
.auth-form-wrap { display: grid; place-items: center; background: var(--color-paper); color: var(--color-ink-2); }
.auth-form { width: min(100%, 27rem); }
.auth-form__heading { margin-block-end: var(--space-lg); display: flex; align-items: center; gap: var(--space-sm); }
.auth-form__icon, .panel-heading__mark { width: 2.75rem; height: 2.75rem; flex: 0 0 auto; display: grid; place-items: center; border: .0625rem solid var(--color-rule-2); border-radius: var(--radius-control); background: var(--color-paper-2); color: var(--color-accent); }
.auth-form h2 { font-size: var(--text-xl); }
.auth-form__heading p { margin-block-start: var(--space-3xs); color: var(--color-muted); }
.auth-form .al { margin-block-end: var(--space-sm); }
.btn-submit { width: 100%; margin-block-start: var(--space-sm); }

/* admin control plane */
.admin-page { background: var(--color-paper-2); }
.admin-shell { min-height: 100dvh; }
.admin-rail { display: none; }
.admin-main { min-width: 0; min-height: 100dvh; display: flex; flex-direction: column; }
.admin-topbar { position: sticky; inset-block-start: 0; z-index: 90; min-height: 4rem; padding-inline: var(--space-sm); display: flex; align-items: center; justify-content: space-between; gap: var(--space-2xs); border-block-end: .0625rem solid var(--color-rule); background: var(--color-paper-a); backdrop-filter: blur(.75rem); }
.admin-topbar nav { min-width: 0; display: flex; align-items: center; gap: var(--space-3xs); overflow-x: auto; }
.admin-topbar nav a { min-height: var(--control-h); padding-inline: var(--space-xs); display: inline-flex; align-items: center; color: var(--color-muted); font-size: var(--text-xs); font-weight: 600; text-decoration: none; white-space: nowrap; }
.admin-content { width: 100%; max-width: 82rem; margin-inline: auto; padding: var(--space-lg) var(--space-sm) var(--space-3xl); }
.admin-overview { margin-block-end: var(--space-xl); }
.admin-heading { margin-block-end: var(--space-xl); display: flex; flex-direction: column; gap: var(--space-sm); }
@media (min-width: 52rem) {
  .admin-heading { flex-direction: row; align-items: flex-end; justify-content: space-between; gap: var(--space-md); }
}
.admin-heading > div:first-child { flex: 1 1 18rem; min-width: 0; }
.admin-heading h1 { font-size: clamp(1.75rem, 3.5vw, 2.25rem); font-weight: 700; line-height: 1.25; margin-block: var(--space-3xs) var(--space-2xs); letter-spacing: -.02em; word-break: keep-all; overflow-wrap: break-word; white-space: normal; }
.admin-heading > div > p:not(.eyebrow) { max-width: 65ch; margin-block-start: var(--space-3xs); color: var(--color-muted); font-size: var(--text-xs); line-height: 1.5; }
.admin-heading__actions { flex: 0 0 auto; display: flex; flex-wrap: wrap; gap: var(--space-2xs); align-items: center; }

.admin-metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-xs); border: none; background: transparent; }
@media (min-width: 48rem) {
  .admin-metrics { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}
.admin-metrics > div { min-width: 0; padding: var(--space-sm) var(--space-md); border: .0625rem solid var(--color-rule); border-radius: var(--radius-panel); background: var(--color-paper); box-shadow: 0 1px 2px rgba(0,0,0,0.03); transition: border-color var(--dur-fast), transform var(--dur-fast); }
.admin-metrics > div:hover { border-color: var(--color-rule-2); }
.admin-metrics > div > span:not(.status-dot) { color: var(--color-ink); font-family: var(--font-display); font-size: var(--text-2xl); font-weight: 700; line-height: 1.1; }
.admin-metrics p { margin-block-start: var(--space-xs); color: var(--color-ink); font-weight: 600; font-size: var(--text-sm); }
.admin-metrics small { color: var(--color-muted); font-size: var(--text-xs); margin-block-start: 2px; display: block; }
.workspace-section { margin-block-start: var(--space-2xl); }
.section-heading--admin { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-sm); padding-block-end: var(--space-sm); border-block-end: .0625rem solid var(--color-rule); }
.section-heading--admin > div { flex: 1 1 12rem; min-width: 0; }
.section-heading--admin code { font-size: var(--text-xs); }
.af-w { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-sm); margin-block-end: var(--space-md); }
.add-form-panel, .mdl-list-panel { min-width: 0; padding: var(--space-md); border: .0625rem solid var(--color-rule-2); border-radius: var(--radius-panel); background: var(--color-paper-2); }
.panel-heading { margin-block-end: var(--space-md); display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-sm); }
.panel-heading > div { min-width: 0; display: flex; align-items: center; gap: var(--space-xs); }
.panel-heading h3 { font-size: var(--text-md); }
.panel-heading p { color: var(--color-muted); font-size: var(--text-xs); }
.mdl-list-panel { max-height: 36rem; overflow-y: auto; margin-bottom: 20px;}
.panel-actions, .detail-actions { display: flex; flex-direction: column; align-items: stretch; gap: var(--space-sm); }
.panel-actions > div, .detail-actions > div { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-2xs); }
.switch-label { min-height: var(--control-h); display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); }
.gp, .provider-list, .key-list { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-xs); }
@media (min-width: 768px) {
  .provider-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-sm); align-items: start; }
}
.pi, .ki { min-width: 0; border: .0625rem solid var(--color-rule); border-radius: var(--radius-control); background: var(--color-paper); }
.pi.pi-yellow { border-color: #fbbf24; background-color: #fffbeb; }
.pi.pi-red { border-color: #f87171; background-color: #fef2f2; }
.ps { min-height: 4.75rem; padding: var(--space-xs); display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); cursor: pointer; }
.ps .l { min-width: 0; display: flex; align-items: center; gap: var(--space-xs); }
.ps .l > div { min-width: 0; }
.ps h3 { font-size: var(--text-md); }
.provider-chevron { width: 1rem; flex: 0 0 auto; color: var(--color-muted); transition: transform var(--dur-fast) var(--ease-out); }
.pu { margin-block-start: var(--space-3xs); display: flex; flex-wrap: wrap; gap: var(--space-2xs); color: var(--color-muted); font-size: var(--text-xs); }
.pu > *:not(:last-child)::after { content: '·'; margin-inline-start: var(--space-2xs); color: var(--color-rule-2); }
.pd { display: none; padding: var(--space-md); border-block-start: .0625rem solid var(--color-rule); background: var(--color-paper-2); }
.pd.open { display: block; }
.detail-heading { margin-block-end: var(--space-md); display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); }
.detail-heading h3 { font-size: var(--text-lg); }
.detail-heading p { margin-block-start: var(--space-3xs); color: var(--color-muted); font-size: var(--text-xs); }
.detail-actions { padding-block-start: var(--space-sm); border-block-start: .0625rem solid var(--color-rule); }
.detail-actions > div:first-child { flex: 1; justify-content: flex-start; }
.ki { padding: var(--space-sm); display: flex; flex-direction: column; gap: var(--space-sm); }
.key-main { min-width: 0; display: flex; align-items: flex-start; gap: var(--space-xs); }
.key-main > div { min-width: 0; }
.key-icon { width: 2.5rem; height: 2.5rem; flex: 0 0 auto; display: grid; place-items: center; border: .0625rem solid var(--color-rule); border-radius: var(--radius-control); background: var(--color-paper-2); color: var(--color-accent); }
.kv { min-width: 0; display: flex; align-items: center; gap: var(--space-3xs); color: var(--color-ink-2); font-family: var(--font-mono); font-size: var(--text-xs); }
.kv > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kv .icon-btn { width: var(--control-h-sm); }
.key-main h3 { margin-block-start: var(--space-3xs); font-size: var(--text-sm); }
.key-main p { color: var(--color-muted); font-size: var(--text-xs); }
/* Key 名称与创建时间一行显示 */
.key-meta { min-width: 0; display: flex; align-items: baseline; gap: var(--space-2xs); }
.key-meta h3 { margin-block-start: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.key-meta p { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.key-meta__sep { color: var(--color-muted); flex: 0 0 auto; }
.key-actions { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-2xs); }

/* feedback, model list and modal */
.al { min-height: var(--control-h); padding: var(--space-xs); display: flex; align-items: center; gap: var(--space-2xs); border: .0625rem solid transparent; border-radius: var(--radius-control); font-size: var(--text-xs); }
.al-s { border-color: var(--color-success); background: var(--color-success-soft); color: var(--color-success-ink); margin-top: 20px; }
.al-e { border-color: var(--color-danger); background: var(--color-danger-soft); color: var(--color-danger-ink); }
.al-i { border-color: var(--color-accent); background: var(--color-accent-soft); color: var(--color-focus); }
.toast { position: fixed; inset-block-start: var(--space-sm); inset-inline-end: var(--space-sm); z-index: 9998; width: min(calc(100% - calc(var(--space-sm) * 2)), 24rem); box-shadow: var(--shadow-float); }
.modal-o { position: fixed; inset: 0; z-index: 9999; padding: var(--space-sm); display: grid; place-items: center; background: var(--color-overlay); color: var(--color-ink-2); }
.modal { width: min(100%, 27rem); max-height: min(80dvh, 40rem); overflow-y: auto; padding: var(--space-md); border: .0625rem solid var(--color-rule-2); border-radius: var(--radius-panel); background: var(--color-paper); color: var(--color-ink-2); box-shadow: var(--shadow-panel); animation: modal-in var(--dur-panel) var(--ease-out); }
.modal h3 { margin-block-end: var(--space-xs); font-size: var(--text-lg); }
.modal p { margin-block-end: var(--space-sm); color: var(--color-muted); }
.modal .fa { margin-block-start: var(--space-sm); display: flex; justify-content: flex-end; gap: var(--space-2xs); }
.mk { margin-block: var(--space-xs); padding: var(--space-sm); border: .0625rem solid var(--color-rule); border-radius: var(--radius-control); background: var(--color-paper-2); color: var(--color-ink); font-family: var(--font-mono); font-size: var(--text-xs); overflow-wrap: anywhere; user-select: all; }
.mdl-item { min-width: 0; min-height: var(--control-h-sm); padding-inline: var(--space-2xs); display: flex; align-items: center; gap: var(--space-2xs); border: .0625rem solid var(--color-rule); border-radius: var(--radius-control); background: var(--color-paper); color: var(--color-ink-2); font-size: var(--text-xs); }
.mdl-item .fx1 { min-width: 0; white-space: normal; overflow-wrap: anywhere; }
.mdl-item i:first-child { color: var(--color-muted); }
.mdl-add-btn { flex-shrink: 0; width: var(--control-h-sm); min-height: 0; font-size: var(--text-md); line-height: 2; }
.grid-2-gap6 { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-2xs); }
@keyframes modal-in { from { opacity: 0; transform: translateY(var(--space-xs)); } to { opacity: 1; transform: none; } }

/* compatibility utilities used by existing interaction code */
.fc { display: flex; align-items: center; gap: var(--space-2xs); }
.fx1 { flex: 1; min-width: 0; }
.fx-s0 { flex-shrink: 0; }
.flex-col { display: flex; flex-direction: column; }
.jc-c { justify-content: center; }
.gap-8, .gp8 { gap: var(--space-2xs); }
.gp3, .gp4 { gap: var(--space-3xs); }
.gp6 { gap: var(--space-2xs); }
.mt-1 { margin-block-start: var(--space-3xs); }
.mt-2, .mt-8 { margin-block-start: var(--space-2xs); }
.mt-3, .mt-6 { margin-block-start: var(--space-2xs); }
.mb-2, .mb-10 { margin-block-end: var(--space-2xs); }
.mb-3, .mb-4 { margin-block-end: var(--space-3xs); }
.m-16-0 { margin-block: var(--space-sm); }
.input-mt-6 { margin-block-start: var(--space-2xs); }
.p-14, .p-10-12 { padding: var(--space-xs); }
.fw { width: 100%; }
.fw-4 { font-weight: 400; }
.fw-6 { font-weight: 600; }
.fw-7 { font-weight: 700; }
.fs-xs, .fs-65, .fs-77 { font-size: var(--text-xs); }
.fs-sm, .fs-s, .fs-88 { font-size: var(--text-sm); }
.fs-1 { font-size: var(--text-md); }
.fs-xxs { font-size: .625rem; }
.w12, .w14, .w16 { width: 1rem; }
.c-p { color: var(--color-accent); }
.c-l, .c-muted, .mu { color: var(--color-muted); }
.c-s { color: var(--color-success); }
/* 复制成功态需压过 .model-token i / .mdl-item i:first-child 的 muted 色（0,2,0 > 0,1,1） */
.model-token i.c-s, .mdl-item i.c-s, .mdl-item i:first-child.c-s { color: var(--color-success); }
.c-d { color: var(--color-danger); }
.mu { font-size: var(--text-xs); }
.tc { text-align: center; }
.va-m { vertical-align: middle; }
.ov { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp { cursor: pointer; user-select: none; }
.cd { padding: var(--space-3xs) var(--space-2xs); border-radius: var(--radius-control); background: var(--color-paper-2); color: var(--color-ink); font-family: var(--font-mono); font-size: var(--text-xs); }
.copy-icon { color: var(--color-muted); font-size: var(--text-xs); }

@media (hover: hover) and (pointer: fine) {
  .btn-p:hover { border-color: var(--color-accent-hover); background: var(--color-accent-hover); }
  .btn-s:hover, .btn-gh:hover, .icon-btn:hover, .password-toggle:hover { border-color: var(--color-rule-2); background: var(--color-paper-2); color: var(--color-ink); }
  .btn-g:hover { border-color: var(--color-success); }
  .btn-d:hover { border-color: var(--color-danger); background: var(--color-danger); color: var(--color-paper); }
  input:hover, textarea:hover, select:hover { background: var(--color-paper-2); }
  .model-token:hover { border-color: var(--color-accent); color: var(--color-focus); }
  .provider-row:hover, .pi:hover, .ki:hover { border-color: var(--color-rule-2); }
  .ps:hover { background: var(--color-paper-2); }
  .admin-nav__link:hover { background: var(--color-paper-2); color: var(--color-ink); }
}

@media (min-width: 40rem) {
  .shell { width: min(100% - calc(var(--space-lg) * 2), var(--shell)); }
  .home-hero { padding-block: var(--space-3xl); }
  .metrics-strip { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .metric { padding-inline: var(--space-md); }
  .metric:first-child { padding-inline-start: 0; }
  .metric:last-child { border-inline-end: 0; }
  .metric:nth-child(even) { border-inline-end: .0625rem solid var(--color-rule); }
  .metric:nth-child(n+3) { border-block-start: 0; }
  .section-heading { grid-template-columns: minmax(0, 1fr) minmax(16rem, .45fr); }
  .provider-row { grid-template-columns: minmax(13rem, .7fr) minmax(0, 1.5fr) auto; align-items: center; }
  .site-footer__inner { flex-direction: row; align-items: center; justify-content: space-between; }
  .auth-context, .auth-form-wrap { padding: var(--space-2xl); }
  .fr { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .fr3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .admin-content { padding-inline: var(--space-lg); }
  .panel-actions, .detail-actions { flex-direction: row; align-items: center; justify-content: space-between; }
  .ki { flex-direction: row; align-items: center; justify-content: space-between; }
  .grid-2-gap6 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (min-width: 60rem) {
  .home-hero { grid-template-columns: minmax(0, .9fr) minmax(28rem, 1.1fr); align-items: center; gap: var(--space-2xl); }
  .auth-shell { grid-template-columns: minmax(0, 1.05fr) minmax(25rem, .95fr); }
  .auth-context { border-block-end: 0; border-inline-end: .0625rem solid var(--color-rule); }
  .admin-shell { display: grid; grid-template-columns: 15rem minmax(0, 1fr); }
  .admin-rail { position: sticky; inset-block-start: 0; height: 100dvh; padding: var(--space-md) var(--space-sm); display: flex; flex-direction: column; border-inline-end: .0625rem solid var(--color-rule); background: var(--color-paper); color: var(--color-ink-2); }
  .admin-rail__brand { padding-inline: var(--space-xs); }
  .admin-rail__brand > span:last-child { display: flex; flex-direction: column; line-height: 1.2; }
  .admin-nav { margin-block-start: var(--space-xl); display: grid; gap: var(--space-3xs); }
  .admin-nav__link { min-height: var(--control-h); padding-inline: var(--space-xs); display: grid; grid-template-columns: 1.25rem minmax(0, 1fr) auto; align-items: center; gap: var(--space-2xs); color: var(--color-muted); font-weight: 600; }
  .admin-nav__link b { min-width: 1.5rem; padding-inline: var(--space-3xs); border-radius: var(--radius-round); background: var(--color-paper-3); color: var(--color-muted); font-family: var(--font-mono); font-size: .625rem; text-align: center; }
  .admin-nav__link.is-active { background: var(--color-accent-soft); color: var(--color-focus); }
  .admin-rail__foot { margin-block-start: auto; display: grid; gap: var(--space-3xs); }
  .admin-topbar { display: none; }
  .admin-content { padding-block-start: var(--space-xl); }
  .grid-2-gap6 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .pd { padding: var(--space-lg); }
}

@media (min-width: 80rem) {
  .admin-content { padding-inline: var(--space-xl); }
}

@media (max-width: 24rem) {
  .brand__descriptor { display: none; }
  .topbar__actions .btn-gh { display: none; }
  .topbar__actions .btn, .topbar--auth .btn { padding-inline: var(--space-xs); }
  .request-panel figcaption { align-items: flex-start; flex-direction: column; justify-content: center; gap: 0; }
  .protocol-state { font-size: .5625rem; }
  .workspace-section { padding: 0; }
  .provider-avatar { display: none; }
  .ps { align-items: flex-start; }
  .ps > .fc { flex-direction: column; align-items: flex-end; }
  .field-row { flex-wrap: wrap; }
  .field-row input { flex-basis: calc(100% - 3.5rem); }
  .field-row .btn { flex: 1; }
  .admin-topbar .brand__name { display: none; }
  .admin-heading__actions .btn { flex: 1; }
}

/* Desktop Compact Optimization & Single-Line Model Rows */
.admin-page {
  --control-h: 2.125rem;
  --control-h-sm: 1.75rem;
}

.admin-page input,
.admin-page select,
.admin-page textarea {
  height: var(--control-h);
  font-size: 0.8125rem;
  padding-inline: 0.625rem;
}

.admin-page .btn {
  min-height: var(--control-h);
  padding-inline: 0.75rem;
  font-size: 0.8125rem;
}

.admin-page .btn-xs {
  min-height: var(--control-h-sm);
  padding-inline: 0.5rem;
  font-size: 0.75rem;
}

.admin-page .icon-btn {
  width: var(--control-h-sm);
  height: var(--control-h-sm);
  flex: 0 0 var(--control-h-sm);
}

.admin-page .form-group {
  margin: 0 0 0.75rem;
  padding: 0.625rem 0.875rem;
  border-radius: var(--radius-control);
}

.admin-page .ps {
  min-height: 3.5rem;
  padding: 0.5rem 0.875rem;
}

.admin-page .pd {
  padding: 0.875rem 1rem;
}

.admin-page .tg {
  height: var(--control-h-sm);
  width: 2.25rem;
  flex: 0 0 2.25rem;
}

.admin-page .tg .sl {
  inset-block-start: 0.3125rem;
  height: 1.125rem;
}

.admin-page .tg .sl::before {
  width: 0.75rem;
  height: 0.75rem;
  inset-inline-start: 0.1875rem;
  inset-block-start: 0.1875rem;
}

.admin-page .tg input:checked + .sl::before {
  transform: translateX(1.125rem);
}

/* 2-line clean layout for provider model list items */
.provider-list .model-single-row:not(.hd),
.model-single-row:not(.hd) {
  display: flex !important;
  flex-direction: column !important;
  align-items: stretch !important;
  gap: 6px !important;
  padding: 8px 10px !important;
  border: 1px solid var(--color-rule) !important;
  border-radius: var(--radius-control) !important;
  background: var(--color-paper) !important;
  margin-bottom: 8px !important;
  min-width: 0 !important;
  width: 100% !important;
  box-shadow: 0 1px 2px rgba(0,0,0,0.02) !important;
}

.model-single-row.hd {
  display: none !important;
}

.model-row-line-1 {
  display: flex !important;
  flex-direction: row !important;
  align-items: center !important;
  justify-content: space-between !important;
  gap: 8px !important;
  width: 100% !important;
}

.model-row-actions-1 {
  display: flex !important;
  align-items: center !important;
  gap: 8px !important;
  flex-shrink: 0 !important;
}

.model-row-line-2 {
  display: flex !important;
  flex-direction: row !important;
  align-items: center !important;
  gap: 6px !important;
  flex-wrap: wrap !important;
  width: 100% !important;
}

.model-single-row input.model-id-input,
.model-single-row input[id^="mid-"],
.model-single-row input.ami,
.provider-list .model-single-row input {
  flex: 1 1 auto !important;
  width: 100% !important;
  min-width: 0 !important;
  height: 1.875rem !important;
  font-size: 0.8125rem !important;
  font-family: var(--font-mono) !important;
  margin: 0 !important;
  padding: 0 8px !important;
  border: 1px solid var(--color-rule-2) !important;
  background: var(--color-paper-2) !important;
  border-radius: var(--radius-control) !important;
}

.model-single-row select {
  height: 1.625rem !important;
  font-size: 0.75rem !important;
  padding: 0 4px !important;
  width: auto !important;
  max-width: 80px !important;
  min-width: 58px !important;
  border: 1px solid var(--color-rule-2) !important;
  background: var(--color-paper-2) !important;
  border-radius: var(--radius-control) !important;
  cursor: pointer !important;
  flex: 0 0 auto !important;
}

.model-single-row select,
.model-single-row .bd,
.model-single-row .latency-chip,
.model-single-row .tg,
.model-single-row .icon-btn,
.model-single-row span {
  flex: 0 0 auto !important;
  white-space: nowrap !important;
}

/* Latency chip badge styling */
.latency-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 600;
  font-family: var(--font-mono);
  background: var(--color-paper-2);
  color: var(--color-muted);
  border: 1px solid var(--color-rule);
  transition: all 0.16s ease;
  user-select: none;
}
.latency-chip.lat-ok {
  background: var(--color-success-soft);
  color: var(--color-success-ink);
  border-color: var(--color-success);
}
.latency-chip.lat-err {
  background: var(--color-danger-soft);
  color: var(--color-danger-ink);
  border-color: var(--color-danger);
}
.latency-chip.lat-loading {
  background: var(--color-accent-soft);
  color: var(--color-focus);
  border-color: var(--color-focus);
}

/* OpenClaw badge styling */
.openclaw-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 4px;
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  transition: opacity 0.3s ease, transform 0.3s ease;
  user-select: none;
  cursor: help;
  animation: fadeInOpenClaw 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes fadeInOpenClaw {
  from { opacity: 0; transform: translateY(2px); }
  to { opacity: 1; transform: translateY(0); }
}

.openclaw-badge--ok {
  background: oklch(95% 0.035 280);
  color: oklch(42% 0.15 280);
  border: 1px solid oklch(88% 0.05 280);
}

.openclaw-badge--no {
  background: oklch(94% 0.008 250);
  color: oklch(48% 0.015 250);
  border: 1px solid oklch(86% 0.012 250);
  opacity: 0.9;
}

@media (pointer: coarse) {
  .btn, .model-token, .password-toggle, input, select { min-height: var(--control-h); }
  .icon-btn, .password-toggle { width: var(--control-h); height: var(--control-h); flex-basis: var(--control-h); }
}

@media (prefers-reduced-motion: reduce) {
  html, body { scroll-behavior: auto; }
  *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; }
  .modal { transform: none; }
}

/* 左侧栏【统一保存】与状态标签样式 */
.rail-save-box {
  margin-block-end: var(--space-xs);
  padding: 0.625rem;
  background: var(--color-paper-2, #f8fafc);
  border: 1px solid var(--color-rule-2, #e2e8f0);
  border-radius: var(--radius-panel, 8px);
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.rail-save-box .badge-status {
  width: 100%;
  box-sizing: border-box;
  justify-content: center;
  text-align: center;
  font-size: 11px;
  padding: 0.25rem 0.5rem;
}
.rail-save-box .btn-save-all {
  width: 100%;
  font-size: 0.875rem;
  font-weight: 600;
  padding: 0.4rem 0.875rem;
  height: 2.25rem;
  border-radius: var(--radius-control, 6px);
  background: var(--color-accent, #2563eb);
  color: #ffffff;
  border: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  transition: all var(--dur-fast) var(--ease-out);
  box-shadow: var(--shadow-sm);
  white-space: nowrap;
}
.rail-save-box .btn-save-all:hover:not(:disabled) {
  background: var(--color-accent-hover, #1d4ed8);
  transform: translateY(-1px);
}

.btn-save-mobile {
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.25rem 0.625rem;
  height: 1.875rem;
  border-radius: var(--radius-control, 6px);
  background: var(--color-accent, #2563eb);
  color: #ffffff;
  border: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}

.badge-status {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3xs);
  padding: 0.35rem 0.75rem;
  border-radius: var(--radius-round);
  font-size: var(--text-xs);
  font-weight: 600;
  line-height: 1;
}
.badge-synced {
  background: var(--color-success-soft);
  color: var(--color-success-ink);
  border: 1px solid var(--color-success);
}
.badge-unsaved {
  background: var(--color-danger-soft);
  color: var(--color-danger-ink);
  border: 1px solid var(--color-danger);
  animation: pulseUnsaved 2s infinite ease-in-out;
}
@keyframes pulseUnsaved {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}
.btn-save-all {
  font-size: 1rem;
  font-weight: 600;
  padding: 0.5rem 1.5rem;
  height: 2.75rem;
  border-radius: var(--radius-control);
  background: var(--color-accent);
  color: var(--color-accent-ink, #ffffff);
  border: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  transition: all var(--dur-fast) var(--ease-out);
  box-shadow: var(--shadow-float);
  white-space: nowrap;
}
.btn-save-all:hover:not(:disabled) {
  background: var(--color-accent-hover);
  transform: translateY(-1px);
}
.btn-save-all:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  filter: grayscale(0.4);
  transform: none;
}

/* Mobile Adaptation for fit & content optimization */
@media (max-width: 48rem) {
  :root {
    --space-xs: 0.375rem;
    --space-sm: 0.5rem;
    --space-md: 0.75rem;
    --space-lg: 1rem;
    --space-xl: 1.25rem;
    --space-2xl: 1.5rem;
    --space-3xl: 2rem;
    --control-h: 2.25rem;
    --control-h-sm: 1.75rem;
  }

  body {
    line-height: 1.4;
  }

  /* Shrink margins/paddings and headings */
  h1 {
    font-size: 1.35rem !important;
  }
  h2 {
    font-size: 1.15rem !important;
  }
  h3 {
    font-size: 0.95rem !important;
  }

  .home-hero {
    padding-block: var(--space-sm) !important;
    gap: var(--space-md) !important;
  }
  .metrics-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
  }
  .metric {
    padding-block: var(--space-3xs) !important;
    padding-inline: var(--space-3xs) !important;
    text-align: center;
  }
  .metric__value {
    font-size: 1.2rem !important;
  }
  .directory {
    padding-block: var(--space-sm) var(--space-md) !important;
  }

  /* Save bar on mobile: more compact */
  .save-floating-bar {
    padding: var(--space-3xs) var(--space-2xs) !important;
    gap: var(--space-2xs) !important;
    margin-bottom: var(--space-2xs) !important;
  }
  .save-status-group {
    gap: 2px !important;
  }
  #save-status-text {
    display: none !important; /* Hide long description to fit key buttons */
  }
  .btn-save-all {
    padding: 0.35rem 0.75rem !important;
    height: 2rem !important;
    font-size: 0.825rem !important;
  }

  /* Admin overview and heading elements */
  .admin-overview {
    margin-bottom: var(--space-md) !important;
  }
  .admin-content {
    padding: var(--space-xs) var(--space-xs) var(--space-xl) !important;
  }
  .admin-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
    gap: var(--space-xs) !important;
  }
  .admin-metrics > div {
    padding: var(--space-xs) var(--space-sm) !important;
  }
  .admin-metrics > div > span:not(.status-dot) {
    font-size: 1.4rem !important;
  }

  /* Optimize to single compact row layout for inputs and buttons inside Provider Details lists */
  .provider-list .field-row {
    display: flex !important;
    flex-wrap: nowrap !important;
    flex-direction: row !important;
    align-items: center !important;
    gap: 4px !important;
    padding: 2px 4px !important;
    border: 1px solid var(--color-rule-2) !important;
    border-radius: var(--radius-control) !important;
    background: var(--color-paper-2) !important;
    margin-bottom: 6px !important;
  }
  .provider-list .field-row > input.fx1,
  .provider-list .field-row > input[id^="mid-"],
  .provider-list .field-row > input[id^="k-"] {
    flex: 1 1 auto !important;
    width: auto !important;
    min-width: 0 !important;
    height: 2rem !important;
    font-size: 0.825rem !important;
    margin-bottom: 0 !important;
  }
  .provider-list .field-row > select,
  .provider-list .field-row > .bd,
  .provider-list .field-row > span,
  .provider-list .field-row > .tg,
  .provider-list .field-row > .icon-btn {
    flex: 0 0 auto !important;
    height: 1.75rem !important;
    min-height: auto !important;
    font-size: 0.75rem !important;
    padding: 1px 4px !important;
  }
}
`
