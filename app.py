import streamlit as st
import pandas as pd
import plotly.graph_objects as go
from pathlib import Path
from scoring import calculate_score

# ── Page config ────────────────────────────────────────────────────────────────
st.set_page_config(
    page_title="AgroPredict Ukraine",
    page_icon="🌾",
    layout="wide",
    initial_sidebar_state="collapsed",
)

# ── Load data ──────────────────────────────────────────────────────────────────
DATA_DIR = Path(__file__).parent

@st.cache_data
def load_data():
    regions = pd.read_csv(DATA_DIR / "regions.csv")
    crops   = pd.read_csv(DATA_DIR / "crops.csv")
    return regions, crops

regions_df, crops_df = load_data()

# ── Design tokens (matching Claude Design mockup palette) ──────────────────────
# Dark forest green base, bright emerald accents, warm cream text
CSS = """
<style>
/* ── Fonts ── */
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');

*, html, body, [class*="css"] {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif !important;
}

/* ── Hide Streamlit chrome ── */
#MainMenu, footer, header { visibility: hidden; }
.block-container {
    padding-top: 0 !important;
    padding-bottom: 0 !important;
    max-width: 100% !important;
}
section[data-testid="stSidebar"] { display: none; }

/* ── Design tokens ── */
:root {
    --forest:    #0F3D2E;   /* deep forest — hero / footer bg           */
    --emerald:   #1B6B47;   /* rich mid-green — dark panels             */
    --mint:      #3DD68C;   /* bright emerald — CTAs / accents          */
    --cream:     #F7F4EC;   /* warm cream — text on dark / page bg      */
    --white:     #FFFFFF;
    --offwhite:  #FAFAF8;   /* near-white sections                      */
    --beige:     #F2EEE6;   /* warm beige — alt section bg              */

    --ink:       #0D1F18;   /* near-black text                          */
    --slate:     #4B6358;   /* muted body text                          */
    --border:    #E3DDD5;   /* warm border                              */
    --border-dk: rgba(255,255,255,0.12); /* border on dark bg          */

    --high-text: #166534;  --high-bg: #DCFCE7;  --high-border: #86EFAC;
    --mod-text:  #92400E;  --mod-bg:  #FEF3C7;  --mod-border:  #FCD34D;
    --risk-text: #9A3412;  --risk-bg: #FFF7ED;  --risk-border: #FDBA74;
    --low-text:  #991B1B;  --low-bg:  #FEF2F2;  --low-border:  #FCA5A5;

    --blue-text: #1E40AF;  --blue-bg: #EFF6FF;  --blue-border: #BFDBFE;
}

/* ── NAV ── */
.nav {
    background: var(--forest);
    padding: 0 2.5rem;
    height: 60px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: sticky;
    top: 0;
    z-index: 1000;
}
.nav-logo {
    font-size: 1.05rem;
    font-weight: 800;
    color: var(--cream);
    letter-spacing: -0.3px;
    display: flex;
    align-items: center;
    gap: 0.5rem;
}
.nav-logo-dot {
    width: 8px; height: 8px;
    background: var(--mint);
    border-radius: 50%;
    display: inline-block;
}
.nav-links {
    display: flex;
    gap: 2rem;
    font-size: 0.82rem;
    font-weight: 500;
    color: rgba(247,244,236,0.55);
}
.nav-cta {
    background: var(--mint);
    color: var(--forest) !important;
    padding: 0.45rem 1.15rem;
    border-radius: 7px;
    font-size: 0.82rem;
    font-weight: 700;
    text-decoration: none;
    letter-spacing: 0.1px;
}

/* ── HERO ── */
.hero {
    background: linear-gradient(160deg, var(--forest) 0%, #133527 55%, #1a4a35 100%);
    padding: 5.5rem 2.5rem 5rem;
    text-align: center;
    position: relative;
    overflow: hidden;
}
.hero::before {
    content: '';
    position: absolute;
    top: -120px; right: -120px;
    width: 480px; height: 480px;
    background: radial-gradient(circle, rgba(61,214,140,0.08) 0%, transparent 70%);
    pointer-events: none;
}
.hero::after {
    content: '';
    position: absolute;
    bottom: -80px; left: -80px;
    width: 360px; height: 360px;
    background: radial-gradient(circle, rgba(61,214,140,0.05) 0%, transparent 70%);
    pointer-events: none;
}
.hero-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    background: rgba(61,214,140,0.12);
    border: 1px solid rgba(61,214,140,0.25);
    color: var(--mint);
    border-radius: 100px;
    padding: 0.3rem 1rem;
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.8px;
    text-transform: uppercase;
    margin-bottom: 1.75rem;
}
.hero-eyebrow-dot { width: 6px; height: 6px; background: var(--mint); border-radius: 50%; }
.hero h1 {
    font-size: 3.2rem;
    font-weight: 800;
    line-height: 1.15;
    color: var(--cream);
    letter-spacing: -0.8px;
    margin-bottom: 1.25rem;
    max-width: 760px;
    margin-left: auto;
    margin-right: auto;
}
.hero h1 em { font-style: normal; color: var(--mint); }
.hero-sub {
    font-size: 1.05rem;
    color: rgba(247,244,236,0.68);
    max-width: 560px;
    margin: 0 auto 2.25rem;
    line-height: 1.7;
    font-weight: 400;
}
.hero-btns {
    display: flex;
    gap: 0.75rem;
    justify-content: center;
    margin-bottom: 3.5rem;
}
.btn-hero-primary {
    background: var(--mint);
    color: var(--forest) !important;
    padding: 0.75rem 1.75rem;
    border-radius: 9px;
    font-weight: 700;
    font-size: 0.92rem;
    text-decoration: none;
    letter-spacing: 0.1px;
    box-shadow: 0 0 0 0 rgba(61,214,140,0.4);
}
.btn-hero-secondary {
    background: rgba(247,244,236,0.08);
    color: var(--cream) !important;
    border: 1px solid rgba(247,244,236,0.2);
    padding: 0.75rem 1.75rem;
    border-radius: 9px;
    font-weight: 600;
    font-size: 0.92rem;
    text-decoration: none;
}

/* ── Preview card ── */
.preview-card {
    background: var(--white);
    border-radius: 18px;
    padding: 1.75rem;
    max-width: 440px;
    margin: 0 auto;
    text-align: left;
    box-shadow: 0 32px 80px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.08);
}
.preview-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 1.25rem;
    padding-bottom: 1.25rem;
    border-bottom: 1px solid var(--border);
}
.preview-prob-big {
    font-size: 2.75rem;
    font-weight: 800;
    color: #166534;
    line-height: 1;
    letter-spacing: -1px;
}
.preview-prob-label {
    font-size: 0.72rem;
    color: var(--slate);
    margin-top: 3px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    font-weight: 500;
}
.preview-badge {
    background: #DCFCE7;
    color: #166534;
    border-radius: 100px;
    padding: 0.3rem 0.85rem;
    font-size: 0.75rem;
    font-weight: 700;
}
.preview-grid {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 1rem 0.5rem;
}
.preview-cell label {
    display: block;
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--slate);
    margin-bottom: 2px;
    font-weight: 500;
}
.preview-cell span {
    font-size: 0.82rem;
    font-weight: 700;
    color: var(--ink);
}

/* ── Section chrome ── */
.section-eyebrow {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    font-weight: 700;
    color: var(--mint);
    margin-bottom: 0.5rem;
    display: flex;
    align-items: center;
    gap: 0.4rem;
}
.section-eyebrow::before {
    content: '';
    display: inline-block;
    width: 20px; height: 2px;
    background: var(--mint);
    border-radius: 2px;
}
.section-h2 {
    font-size: 2rem;
    font-weight: 800;
    color: var(--ink);
    letter-spacing: -0.5px;
    line-height: 1.2;
    margin-bottom: 0.5rem;
}
.section-h2-cream { color: var(--cream); }
.section-sub {
    font-size: 0.95rem;
    color: var(--slate);
    line-height: 1.65;
    margin-bottom: 2rem;
}
.section-sub-muted { color: rgba(247,244,236,0.6); }

/* ── Split layout wrapper ── */
.split-panel {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.5rem;
    align-items: start;
}

/* ── Calculator card ── */
.calc-card {
    background: var(--white);
    border-radius: 18px;
    border: 1px solid var(--border);
    box-shadow: 0 4px 32px rgba(15,61,46,0.07);
    overflow: hidden;
}
.calc-card-header {
    background: var(--forest);
    padding: 1.35rem 1.75rem;
    border-bottom: 1px solid var(--border-dk);
}
.calc-card-title {
    font-size: 0.95rem;
    font-weight: 700;
    color: var(--cream);
    margin-bottom: 0.2rem;
}
.calc-card-sub {
    font-size: 0.78rem;
    color: rgba(247,244,236,0.55);
    font-weight: 400;
}
.calc-card-body { padding: 1.5rem 1.75rem; }

/* ── Heatmap card ── */
.heatmap-card {
    background: var(--white);
    border-radius: 18px;
    border: 1px solid var(--border);
    box-shadow: 0 4px 32px rgba(15,61,46,0.07);
    overflow: hidden;
}
.heatmap-card-header {
    background: var(--forest);
    padding: 1.35rem 1.75rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
}
.heatmap-card-title {
    font-size: 0.95rem;
    font-weight: 700;
    color: var(--cream);
    margin-bottom: 0.2rem;
}
.heatmap-card-sub {
    font-size: 0.78rem;
    color: rgba(247,244,236,0.55);
}
.heatmap-card-body { padding: 1.25rem 1.5rem; }

/* ── Legend ── */
.legend {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-bottom: 1rem;
}
.legend-item {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.72rem;
    color: var(--slate);
    font-weight: 500;
}
.legend-pip {
    width: 10px; height: 10px;
    border-radius: 3px;
    flex-shrink: 0;
}

/* ── Region tile ── */
.region-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.5rem;
}
.region-tile {
    border-radius: 10px;
    padding: 0.65rem 0.75rem;
    text-align: center;
    border: 1.5px solid transparent;
    transition: transform 0.1s;
}
.region-tile-pct {
    font-size: 1.15rem;
    font-weight: 800;
    line-height: 1;
    margin-bottom: 1px;
}
.region-tile-label {
    font-size: 0.58rem;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    font-weight: 700;
    margin-bottom: 3px;
}
.region-tile-name {
    font-size: 0.68rem;
    font-weight: 500;
    color: #374151;
}

/* ── Metric cards ── */
.metric-card {
    background: var(--white);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 1.1rem 1.25rem;
    height: 100%;
}
.metric-label {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--slate);
    font-weight: 600;
    margin-bottom: 6px;
}
.metric-value {
    font-size: 1.65rem;
    font-weight: 800;
    color: var(--ink);
    letter-spacing: -0.5px;
    line-height: 1;
}
.metric-sub {
    font-size: 0.75rem;
    color: var(--slate);
    margin-top: 5px;
}
.prob-track {
    height: 7px;
    background: #E5E7EB;
    border-radius: 99px;
    margin-top: 8px;
    overflow: hidden;
}
.prob-fill {
    height: 100%;
    border-radius: 99px;
    transition: width 0.5s ease;
}

/* ── Recommendation card ── */
.rec-card {
    background: var(--blue-bg);
    border: 1px solid var(--blue-border);
    border-radius: 14px;
    padding: 1.25rem 1.4rem;
    margin-top: 0.75rem;
}
.rec-label {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    font-weight: 700;
    color: var(--blue-text);
    margin-bottom: 0.5rem;
}
.rec-body {
    font-size: 0.88rem;
    color: #1E3A5F;
    line-height: 1.7;
}

/* ── Risk / Steps cards ── */
.risk-card {
    background: #FFF7ED;
    border: 1px solid #FED7AA;
    border-radius: 14px;
    padding: 1.1rem 1.25rem;
    height: 100%;
}
.risk-label {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    font-weight: 700;
    color: #C2410C;
    margin-bottom: 0.6rem;
}
.risk-item {
    font-size: 0.82rem;
    color: #7C2D12;
    margin-bottom: 5px;
    line-height: 1.45;
    display: flex;
    gap: 0.4rem;
}
.steps-card {
    background: #F0FDF4;
    border: 1px solid #BBF7D0;
    border-radius: 14px;
    padding: 1.1rem 1.25rem;
    height: 100%;
}
.steps-label {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    font-weight: 700;
    color: #166534;
    margin-bottom: 0.6rem;
}
.steps-item {
    font-size: 0.82rem;
    color: #14532D;
    margin-bottom: 5px;
    line-height: 1.45;
    display: flex;
    gap: 0.4rem;
}

/* ── Value cards (dark section) ── */
.value-card {
    background: rgba(61,214,140,0.06);
    border: 1px solid rgba(61,214,140,0.18);
    border-radius: 16px;
    padding: 1.5rem;
    height: 100%;
}
.value-icon {
    font-size: 1.6rem;
    margin-bottom: 0.75rem;
    display: block;
}
.value-title {
    font-size: 0.95rem;
    font-weight: 700;
    color: var(--cream);
    margin-bottom: 0.35rem;
}
.value-body {
    font-size: 0.82rem;
    color: rgba(247,244,236,0.62);
    line-height: 1.65;
}

/* ── How it works ── */
.how-card {
    background: var(--white);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 1.5rem;
    height: 100%;
    position: relative;
}
.how-num {
    width: 34px; height: 34px;
    background: var(--forest);
    color: var(--mint);
    border-radius: 10px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 0.85rem;
    font-weight: 800;
    margin-bottom: 0.85rem;
}
.how-title {
    font-size: 0.92rem;
    font-weight: 700;
    color: var(--ink);
    margin-bottom: 0.35rem;
}
.how-body {
    font-size: 0.82rem;
    color: var(--slate);
    line-height: 1.6;
}

/* ── Roadmap cards ── */
.road-card {
    background: var(--offwhite);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 1.5rem;
    height: 100%;
    border-top: 3px solid transparent;
}
.road-badge {
    display: inline-block;
    border-radius: 6px;
    padding: 0.2rem 0.6rem;
    font-size: 0.68rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    margin-bottom: 0.75rem;
}
.road-title {
    font-size: 0.95rem;
    font-weight: 700;
    color: var(--ink);
    margin-bottom: 0.85rem;
}
.road-item {
    font-size: 0.8rem;
    color: var(--slate);
    margin-bottom: 6px;
    display: flex;
    gap: 0.4rem;
    align-items: flex-start;
    line-height: 1.4;
}
.road-check { flex-shrink: 0; margin-top: 1px; }

/* ── Footer ── */
.footer {
    background: var(--forest);
    padding: 3rem 2.5rem;
    text-align: center;
}
.footer-logo {
    font-size: 1rem;
    font-weight: 800;
    color: var(--cream);
    margin-bottom: 0.6rem;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
}
.footer-tagline {
    font-size: 0.85rem;
    color: rgba(247,244,236,0.55);
    margin-bottom: 1rem;
    line-height: 1.6;
}
.footer-disclaimer {
    font-size: 0.75rem;
    color: rgba(247,244,236,0.3);
    max-width: 560px;
    margin: 0 auto 1.25rem;
    line-height: 1.6;
}
.footer-copy {
    font-size: 0.72rem;
    color: rgba(247,244,236,0.2);
}

/* ── Streamlit input overrides ── */
div[data-testid="stSelectbox"] label,
div[data-testid="stNumberInput"] label {
    font-size: 0.68rem !important;
    font-weight: 700 !important;
    color: var(--slate) !important;
    text-transform: uppercase !important;
    letter-spacing: 0.5px !important;
}
div[data-testid="stSelectbox"] > div > div,
div[data-testid="stNumberInput"] > div > div > input {
    border-radius: 9px !important;
    border-color: var(--border) !important;
    background: var(--offwhite) !important;
    font-size: 0.88rem !important;
    color: var(--ink) !important;
}
div[data-testid="stButton"] > button {
    background: var(--forest) !important;
    color: var(--mint) !important;
    border: none !important;
    border-radius: 10px !important;
    font-weight: 800 !important;
    font-size: 0.88rem !important;
    padding: 0.7rem 1.5rem !important;
    width: 100% !important;
    letter-spacing: 0.2px !important;
    transition: background 0.15s !important;
}
div[data-testid="stButton"] > button:hover {
    background: var(--emerald) !important;
}

/* ── Section spacing helper ── */
.sp-sm  { height: 1.5rem; }
.sp-md  { height: 3rem; }
.sp-lg  { height: 4.5rem; }

/* ── Suitability pill ── */
.suit-pill {
    display: inline-block;
    border-radius: 8px;
    padding: 0.4rem 0.9rem;
    font-size: 0.88rem;
    font-weight: 700;
}

/* ── Result section wrapper ── */
.result-section {
    background: var(--beige);
    padding: 2.5rem;
    border-radius: 0;
    margin-top: 0;
}
.result-banner {
    background: var(--forest);
    border-radius: 14px;
    padding: 1.25rem 1.5rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1.25rem;
}
.result-banner-left h3 {
    font-size: 1.15rem;
    font-weight: 800;
    color: var(--cream);
    margin-bottom: 0.2rem;
}
.result-banner-left p {
    font-size: 0.8rem;
    color: rgba(247,244,236,0.6);
}

/* ── Full-width bg hack for dark sections ── */
.dark-section-bg {
    background: var(--forest);
    margin-left: -2rem;
    margin-right: -2rem;
    padding: 4rem 2rem;
}
</style>
"""
st.markdown(CSS, unsafe_allow_html=True)


# ── Helper: suitability colors ─────────────────────────────────────────────────
def suit_colors(prob):
    if prob >= 75:
        return {"text": "#166534", "bg": "#DCFCE7", "border": "#86EFAC", "label": "High Suitability", "bar": "#22C55E"}
    elif prob >= 55:
        return {"text": "#92400E", "bg": "#FEF3C7", "border": "#FCD34D", "label": "Moderate Suitability", "bar": "#F59E0B"}
    elif prob >= 35:
        return {"text": "#9A3412", "bg": "#FFF7ED", "border": "#FDBA74", "label": "Risky",              "bar": "#F97316"}
    else:
        return {"text": "#991B1B", "bg": "#FEF2F2", "border": "#FCA5A5", "label": "Low Suitability",   "bar": "#EF4444"}


# ─────────────────────────────────────────────────────────────────────────────
# NAV
# ─────────────────────────────────────────────────────────────────────────────
st.markdown("""
<div class="nav">
  <div class="nav-logo">
    <span class="nav-logo-dot"></span>
    AgroPredict Ukraine
  </div>
  <div class="nav-links">
    <span>Product</span>
    <span>Calculator</span>
    <span>Map</span>
    <span>Impact</span>
    <span>Roadmap</span>
  </div>
  <a class="nav-cta" href="#">Start Analysis</a>
</div>
""", unsafe_allow_html=True)


# ─────────────────────────────────────────────────────────────────────────────
# HERO
# ─────────────────────────────────────────────────────────────────────────────
st.markdown("""
<div class="hero">
  <div class="hero-eyebrow">
    <span class="hero-eyebrow-dot"></span>
    Agri-Tech &nbsp;·&nbsp; Decision Intelligence &nbsp;·&nbsp; Ukraine Recovery
  </div>
  <h1>
    <em>AI-powered</em> crop suitability<br>insights for Ukrainian farmland
  </h1>
  <p class="hero-sub">
    Estimate crop success probability using soil type, drought risk, historical yield,
    and soil exhaustion indicators — before you plant.
  </p>
  <div class="hero-btns">
    <a class="btn-hero-primary" href="#">↓ Start Analysis</a>
    <a class="btn-hero-secondary" href="#">View Demo Report</a>
  </div>

  <div class="preview-card">
    <div class="preview-top">
      <div>
        <div class="preview-prob-big">74%</div>
        <div class="preview-prob-label">Success Probability</div>
      </div>
      <span class="preview-badge">High Suitability</span>
    </div>
    <div class="preview-grid">
      <div class="preview-cell"><label>Region</label><span>Poltava</span></div>
      <div class="preview-cell"><label>Crop</label><span>Wheat</span></div>
      <div class="preview-cell"><label>Soil</label><span>Chernozem</span></div>
      <div class="preview-cell"><label>Drought</label><span>Medium</span></div>
      <div class="preview-cell"><label>Exhaustion</label><span>30/100</span></div>
      <div class="preview-cell"><label>Yield Index</label><span>High</span></div>
    </div>
  </div>
</div>
""", unsafe_allow_html=True)


# ─────────────────────────────────────────────────────────────────────────────
# MAIN SPLIT PANEL: HEATMAP (left) + CALCULATOR (right)
# ─────────────────────────────────────────────────────────────────────────────
st.markdown("<div style='height:3rem'></div>", unsafe_allow_html=True)

# Section header
st.markdown("""
<div style="padding:0 0.5rem 0.25rem">
  <div class="section-eyebrow">Field Intelligence Platform</div>
  <h2 class="section-h2">Analyze your field</h2>
  <p class="section-sub" style="max-width:560px">
    Select a Ukrainian oblast and crop to see an estimated success probability
    based on soil, historical yield, drought, and rotation data.
  </p>
</div>
""", unsafe_allow_html=True)

# Build heatmap scores eagerly (needs widget state for crop / prev crop)
# We'll compute after inputs are rendered, but we pre-define placeholders here.

left_col, right_col = st.columns([1.05, 0.95], gap="large")

# ── RIGHT: Calculator ──────────────────────────────────────────────────────────
with right_col:
    st.markdown("""
    <div class="calc-card">
      <div class="calc-card-header">
        <div class="calc-card-title">Crop Suitability Calculator</div>
        <div class="calc-card-sub">Enter field parameters below</div>
      </div>
    </div>
    """, unsafe_allow_html=True)

    # Inputs inside the card body — we can't nest Streamlit widgets inside HTML divs,
    # so we use a styled container and override widget CSS.
    with st.container():
        st.markdown("<div style='background:white;border:1px solid #E3DDD5;border-top:none;border-radius:0 0 18px 18px;padding:1.4rem 1.6rem 1.6rem'>", unsafe_allow_html=True)

        region_options = sorted(regions_df["oblast"].tolist())
        selected_region = st.selectbox(
            "Ukrainian Oblast / Region",
            region_options,
            index=region_options.index("Poltava Oblast"),
        )

        c_crop, c_prev = st.columns(2)
        with c_crop:
            selected_crop = st.selectbox("Crop", crops_df["crop"].tolist())
        with c_prev:
            selected_prev = st.selectbox(
                "Previous Crop",
                ["None", "Wheat", "Corn", "Sunflower", "Soybean", "Rapeseed"],
            )

        c_lat, c_lon = st.columns(2)
        with c_lat:
            lat = st.number_input(
                "Latitude (optional)", min_value=44.0, max_value=53.0,
                value=None, placeholder="e.g. 49.59"
            )
        with c_lon:
            lon = st.number_input(
                "Longitude (optional)", min_value=22.0, max_value=40.0,
                value=None, placeholder="e.g. 34.54"
            )

        field_size = st.number_input(
            "Field Size — hectares (optional)",
            min_value=0.0, value=None, placeholder="e.g. 250 ha"
        )

        analyze_clicked = st.button("Analyze Field →")
        st.markdown("</div>", unsafe_allow_html=True)

    # ── Quick comparison chips (static reference) ──────────────────────────────
    region_row_live = regions_df[regions_df["oblast"] == selected_region].iloc[0]
    live_results = {}
    for _, cr in crops_df.iterrows():
        r = calculate_score(region_row_live, cr, selected_prev)
        live_results[cr["crop"]] = r["success_probability"]

    chips_html = ""
    for crop_name, pct in live_results.items():
        sc = suit_colors(pct)
        active = "border:2px solid " + sc["bar"] if crop_name == selected_crop else "border:1.5px solid #E3DDD5"
        chips_html += f"""
        <div style="flex:1;background:{sc['bg']};{active};border-radius:10px;
                    padding:0.6rem 0.75rem;text-align:center">
          <div style="font-size:1.1rem;font-weight:800;color:{sc['text']}">{pct}%</div>
          <div style="font-size:0.65rem;color:{sc['text']};text-transform:uppercase;
                      letter-spacing:0.4px;font-weight:700;margin:1px 0 2px">{sc['label'].split()[0]}</div>
          <div style="font-size:0.72rem;color:#374151;font-weight:600">{crop_name}</div>
        </div>"""

    st.markdown(f"""
    <div style="margin-top:1rem">
      <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:0.6px;
                  font-weight:700;color:#4B6358;margin-bottom:0.5rem">
        All crops · {selected_region.replace(' Oblast','')} · prev: {selected_prev}
      </div>
      <div style="display:flex;gap:0.4rem">{chips_html}</div>
    </div>
    """, unsafe_allow_html=True)


# ── LEFT: Heatmap ──────────────────────────────────────────────────────────────
with left_col:
    # Compute heatmap scores for selected crop + prev crop
    heatmap_scores = {}
    for _, r in regions_df.iterrows():
        cr = crops_df[crops_df["crop"] == selected_crop].iloc[0]
        res = calculate_score(r, cr, selected_prev)
        heatmap_scores[r["oblast"]] = res["success_probability"]

    st.markdown(f"""
    <div class="heatmap-card">
      <div class="heatmap-card-header">
        <div>
          <div class="heatmap-card-title">Ukraine Crop Suitability Map</div>
          <div class="heatmap-card-sub">{selected_crop} · prev: {selected_prev}</div>
        </div>
      </div>
      <div class="heatmap-card-body">
        <div class="legend">
          <div class="legend-item"><div class="legend-pip" style="background:#22C55E"></div> High (75–100%)</div>
          <div class="legend-item"><div class="legend-pip" style="background:#F59E0B"></div> Moderate (55–74%)</div>
          <div class="legend-item"><div class="legend-pip" style="background:#F97316"></div> Risky (35–54%)</div>
          <div class="legend-item"><div class="legend-pip" style="background:#EF4444"></div> Low (&lt;35%)</div>
        </div>
    """, unsafe_allow_html=True)

    # Region tiles — sorted by score desc, 3 per row
    sorted_regions = sorted(heatmap_scores.keys(), key=lambda x: heatmap_scores[x], reverse=True)
    tile_rows = [sorted_regions[i:i+3] for i in range(0, len(sorted_regions), 3)]

    for row in tile_rows:
        cols = st.columns(len(row))
        for i, oblast in enumerate(row):
            pct = heatmap_scores[oblast]
            sc  = suit_colors(pct)
            is_selected = (oblast == selected_region)
            ring = f"box-shadow:0 0 0 2.5px {sc['bar']},0 0 0 4px {sc['bg']};" if is_selected else ""
            with cols[i]:
                st.markdown(f"""
                <div style="background:{sc['bg']};border:1.5px solid {sc['border']};
                            border-radius:11px;padding:0.7rem 0.5rem;text-align:center;{ring}">
                  <div style="font-size:1.3rem;font-weight:800;color:{sc['text']};line-height:1">{pct}%</div>
                  <div style="font-size:0.58rem;font-weight:700;color:{sc['text']};
                              text-transform:uppercase;letter-spacing:0.4px;margin:2px 0 3px">{sc['label'].split()[0]}</div>
                  <div style="font-size:0.7rem;font-weight:600;color:#374151">
                    {oblast.replace(' Oblast','')}
                    {'<span style="color:' + sc['bar'] + '"> ●</span>' if is_selected else ''}
                  </div>
                </div>
                """, unsafe_allow_html=True)

    st.markdown("</div></div>", unsafe_allow_html=True)

    # Plotly horizontal bar chart
    sorted_bar = sorted(heatmap_scores.keys(), key=lambda x: heatmap_scores[x])
    bar_colors = [suit_colors(heatmap_scores[o])["bar"] for o in sorted_bar]

    fig = go.Figure()
    fig.add_trace(go.Bar(
        x=[heatmap_scores[o] for o in sorted_bar],
        y=[o.replace(" Oblast", "") for o in sorted_bar],
        orientation="h",
        marker=dict(color=bar_colors, line=dict(width=0)),
        text=[f"{heatmap_scores[o]}%" for o in sorted_bar],
        textposition="outside",
        textfont=dict(size=10, color="#374151"),
        hovertemplate="<b>%{y}</b><br>%{x}% success probability<extra></extra>",
    ))
    fig.update_layout(
        height=360,
        margin=dict(l=0, r=40, t=8, b=8),
        plot_bgcolor="#FAFAF8",
        paper_bgcolor="#FAFAF8",
        xaxis=dict(
            range=[0, 108],
            showgrid=True, gridcolor="#E3DDD5", gridwidth=1,
            ticksuffix="%", tickfont=dict(size=10, color="#4B6358"),
            zeroline=False, showline=False,
        ),
        yaxis=dict(
            showgrid=False, tickfont=dict(size=10, color="#374151"),
        ),
        font=dict(family="Inter, sans-serif"),
        bargap=0.35,
    )
    st.plotly_chart(fig, use_container_width=True, config={"displayModeBar": False})


# ─────────────────────────────────────────────────────────────────────────────
# RESULTS DASHBOARD (conditional)
# ─────────────────────────────────────────────────────────────────────────────
if analyze_clicked:
    region_row = regions_df[regions_df["oblast"] == selected_region].iloc[0]
    crop_row   = crops_df[crops_df["crop"] == selected_crop].iloc[0]
    result     = calculate_score(region_row, crop_row, selected_prev)

    prob       = result["success_probability"]
    exhaustion = result["soil_exhaustion_score"]
    sc         = suit_colors(prob)

    drought_c = {"low": "#166534", "medium": "#92400E", "high": "#991B1B"}.get(result["drought_risk"], "#4B6358")
    ex_c = "#166534" if exhaustion < 35 else ("#92400E" if exhaustion < 60 else "#991B1B")
    ex_label = "Low depletion" if exhaustion < 35 else ("Moderate depletion" if exhaustion < 60 else "High depletion")

    st.markdown("<div style='height:2.5rem'></div>", unsafe_allow_html=True)

    # Banner
    st.markdown(f"""
    <div class="result-banner" style="background:var(--forest)">
      <div class="result-banner-left">
        <h3>Field Intelligence Report</h3>
        <p>{selected_region} &nbsp;·&nbsp; {selected_crop} &nbsp;·&nbsp; prev: {selected_prev}</p>
      </div>
      <span class="suit-pill" style="background:{sc['bg']};color:{sc['text']};
            border:1.5px solid {sc['border']}">{sc['label']}</span>
    </div>
    """, unsafe_allow_html=True)

    # Row 1: 6 metric cards
    mc1, mc2, mc3, mc4, mc5, mc6 = st.columns(6)

    with mc1:
        st.markdown(f"""
        <div class="metric-card">
          <div class="metric-label">Success Probability</div>
          <div class="metric-value" style="color:{sc['text']}">{prob}%</div>
          <div class="prob-track"><div class="prob-fill" style="width:{prob}%;background:{sc['bar']}"></div></div>
          <div class="metric-sub">{sc['label']}</div>
        </div>""", unsafe_allow_html=True)

    with mc2:
        st.markdown(f"""
        <div class="metric-card">
          <div class="metric-label">Soil Type</div>
          <div class="metric-value" style="font-size:1.05rem;padding-top:5px">{result['soil_type']}</div>
          <div class="metric-sub">Regional classification</div>
        </div>""", unsafe_allow_html=True)

    with mc3:
        st.markdown(f"""
        <div class="metric-card">
          <div class="metric-label">Avg Regional Yield</div>
          <div class="metric-value" style="font-size:1.25rem;padding-top:3px">{result['average_yield_index'].capitalize()}</div>
          <div class="metric-sub">Historical performance</div>
        </div>""", unsafe_allow_html=True)

    with mc4:
        st.markdown(f"""
        <div class="metric-card">
          <div class="metric-label">Drought Risk</div>
          <div class="metric-value" style="color:{drought_c};font-size:1.25rem;padding-top:3px">{result['drought_risk'].capitalize()}</div>
          <div class="metric-sub">Regional climate index</div>
        </div>""", unsafe_allow_html=True)

    with mc5:
        st.markdown(f"""
        <div class="metric-card">
          <div class="metric-label">Soil Exhaustion</div>
          <div class="metric-value" style="color:{ex_c}">{exhaustion}<span style="font-size:0.9rem;color:#9CA3AF">/100</span></div>
          <div class="prob-track"><div class="prob-fill" style="width:{exhaustion}%;background:{ex_c}"></div></div>
          <div class="metric-sub">{ex_label}</div>
        </div>""", unsafe_allow_html=True)

    with mc6:
        st.markdown(f"""
        <div class="metric-card">
          <div class="metric-label">Estimated Suitability</div>
          <div style="margin-top:10px">
            <span class="suit-pill" style="background:{sc['bg']};color:{sc['text']};
                  border:1.5px solid {sc['border']};font-size:0.82rem">{sc['label']}</span>
          </div>
          <div class="metric-sub" style="margin-top:8px">Composite score</div>
        </div>""", unsafe_allow_html=True)

    # AI recommendation
    st.markdown(f"""
    <div class="rec-card">
      <div class="rec-label">🤖 AI-Style Recommendation</div>
      <div class="rec-body">{result['recommendation']}</div>
    </div>
    """, unsafe_allow_html=True)

    # Risk + Next steps
    r_col, s_col = st.columns(2)
    with r_col:
        items = "".join(f'<div class="risk-item"><span>⚠</span><span>{x}</span></div>' for x in result["key_risk_factors"])
        st.markdown(f'<div class="risk-card"><div class="risk-label">Key Risk Factors</div>{items}</div>', unsafe_allow_html=True)
    with s_col:
        items = "".join(f'<div class="steps-item"><span>→</span><span>{x}</span></div>' for x in result["suggested_next_steps"])
        st.markdown(f'<div class="steps-card"><div class="steps-label">Suggested Next Steps</div>{items}</div>', unsafe_allow_html=True)

    if field_size:
        msg = (
            f"At {prob}% success probability, a trial plot is advisable before committing all {field_size:.0f} ha."
            if prob < 65 else
            f"Conditions support full deployment across {field_size:.0f} ha. Confirm with an on-site soil test."
        )
        st.markdown(f"""
        <div style="background:#F7F4EC;border:1px solid #E3DDD5;border-radius:12px;
                    padding:0.9rem 1.25rem;margin-top:0.75rem;font-size:0.85rem;color:#0D1F18">
          <strong>Field context ({field_size:.0f} ha)</strong> — {msg}
        </div>
        """, unsafe_allow_html=True)

    st.markdown("<div style='height:1rem'></div>", unsafe_allow_html=True)


# ─────────────────────────────────────────────────────────────────────────────
# BUSINESS VALUE (dark section)
# ─────────────────────────────────────────────────────────────────────────────
st.markdown("<div style='height:1.5rem'></div>", unsafe_allow_html=True)
st.markdown("""
<div style="background:#0F3D2E;padding:4.5rem 0 1.5rem;margin:0">
  <div style="text-align:center;padding:0 2rem">
    <div class="section-eyebrow" style="justify-content:center;color:#3DD68C">
      <span style="background:#3DD68C;display:inline-block;width:20px;height:2px;border-radius:2px"></span>
      Why AgroPredict Ukraine
    </div>
    <h2 class="section-h2 section-h2-cream" style="margin-bottom:0.5rem">Built for real agricultural decisions</h2>
    <p class="section-sub section-sub-muted" style="max-width:520px;margin:0 auto 2.5rem">
      Supporting Ukraine's agricultural sector with structured, data-informed planting choices.
    </p>
  </div>
</div>
""", unsafe_allow_html=True)

bv1, bv2, bv3, bv4 = st.columns(4)
bv_data = [
    ("📉", "Reduce Farming Uncertainty", "Replace guesswork with structured, data-driven crop suitability estimates before committing resources."),
    ("🌾", "Improve Crop Selection", "Compare multiple crops across regions to identify the highest-probability planting strategy for your land."),
    ("♻️", "Sustainable Soil Use", "Exhaustion scoring helps farmers protect long-term field productivity through better rotation planning."),
    ("🇺🇦", "Aid Ukraine's Recovery", "Helping Ukrainian agribusinesses rebuild efficiently and sustainably after years of disruption."),
]
for col, (icon, title, body) in zip([bv1, bv2, bv3, bv4], bv_data):
    with col:
        st.markdown(f"""
        <div style="background:rgba(61,214,140,0.06);border:1px solid rgba(61,214,140,0.18);
                    border-radius:16px;padding:1.5rem;height:100%">
          <span style="font-size:1.6rem;display:block;margin-bottom:0.75rem">{icon}</span>
          <div style="font-size:0.92rem;font-weight:700;color:#F7F4EC;margin-bottom:0.35rem">{title}</div>
          <div style="font-size:0.8rem;color:rgba(247,244,236,0.62);line-height:1.65">{body}</div>
        </div>
        """, unsafe_allow_html=True)

st.markdown("<div style='height:3rem;background:#0F3D2E'></div>", unsafe_allow_html=True)


# ─────────────────────────────────────────────────────────────────────────────
# HOW IT WORKS
# ─────────────────────────────────────────────────────────────────────────────
st.markdown("<div style='height:1rem'></div>", unsafe_allow_html=True)
st.markdown("""
<div style="text-align:center;padding:0 0.5rem">
  <div class="section-eyebrow" style="justify-content:center">Process</div>
  <h2 class="section-h2">How it works</h2>
  <p class="section-sub" style="max-width:480px;margin:0 auto 2rem">
    Four steps from field selection to actionable crop intelligence.
  </p>
</div>
""", unsafe_allow_html=True)

hw1, hw2, hw3, hw4 = st.columns(4)
hw_data = [
    ("01", "Select region or coordinates", "Choose an oblast or enter GPS coordinates to localise your analysis."),
    ("02", "Choose crop and rotation", "Select your planned crop and the previous season's crop to factor in rotation effects."),
    ("03", "Analyze soil and climate", "The model evaluates soil type, drought risk, yield history, and exhaustion indicators."),
    ("04", "Receive recommendation", "Get a success probability score, key risk factors, and actionable next steps."),
]
for col, (num, title, body) in zip([hw1, hw2, hw3, hw4], hw_data):
    with col:
        st.markdown(f"""
        <div class="how-card">
          <div class="how-num">{num}</div>
          <div class="how-title">{title}</div>
          <div class="how-body">{body}</div>
        </div>
        """, unsafe_allow_html=True)

st.markdown("<div style='height:3rem'></div>", unsafe_allow_html=True)


# ─────────────────────────────────────────────────────────────────────────────
# ROADMAP
# ─────────────────────────────────────────────────────────────────────────────
st.markdown("""
<div style="background:#F2EEE6;padding:4rem 0 0.5rem">
  <div style="text-align:center;padding:0 0.5rem">
    <div class="section-eyebrow" style="justify-content:center">Product Roadmap</div>
    <h2 class="section-h2">From MVP to precision agriculture</h2>
    <p class="section-sub" style="max-width:500px;margin:0 auto 2rem">
      A staged plan toward real-time satellite-powered field intelligence.
    </p>
  </div>
</div>
""", unsafe_allow_html=True)

rm1, rm2, rm3 = st.columns(3)
roadmap_data = [
    ("#0F3D2E", "#3DD68C", "#DCFCE7", "Live Now", "Stage 1 — Current MVP", [
        "Oblast-level crop suitability calculator",
        "Rule-based scoring model",
        "15 Ukrainian oblasts with demo data",
        "Interactive heatmap visualization",
        "AI-style recommendation engine",
    ]),
    ("#92400E", "#F59E0B", "#FEF3C7", "Next 6 Months", "Stage 2 — Coordinate Analysis", [
        "GPS latitude/longitude field input",
        "Automatic micro-climate detection",
        "Granular soil and climate sub-indicators",
        "Multi-season crop rotation planner",
        "PDF field report export",
    ]),
    ("#3730A3", "#818CF8", "#EEF2FF", "12–18 Months", "Stage 3 — Field Intelligence", [
        "Sentinel-2 satellite imagery integration",
        "ERA5 historical climate time-series",
        "OpenLandMap / ISRIC real soil datasets",
        "Machine learning model (XGBoost)",
        "10 km radius field-level intelligence",
    ]),
]
for col, (accent, badge_text_c, badge_bg, timeline, title, items) in zip([rm1, rm2, rm3], roadmap_data):
    with col:
        items_html = "".join(
            f'<div class="road-item"><span class="road-check" style="color:{accent}">✓</span><span>{it}</span></div>'
            for it in items
        )
        st.markdown(f"""
        <div class="road-card" style="border-top-color:{accent};background:#FAFAF8">
          <span class="road-badge" style="background:{badge_bg};color:{badge_text_c}">{timeline}</span>
          <div class="road-title">{title}</div>
          {items_html}
        </div>
        """, unsafe_allow_html=True)

st.markdown("<div style='height:3rem;background:#F2EEE6'></div>", unsafe_allow_html=True)


# ─────────────────────────────────────────────────────────────────────────────
# FOOTER
# ─────────────────────────────────────────────────────────────────────────────
st.markdown("""
<div class="footer">
  <div class="footer-logo">
    <span style="width:7px;height:7px;background:#3DD68C;border-radius:50%;display:inline-block"></span>
    AgroPredict Ukraine
  </div>
  <p class="footer-tagline">
    Built as an MBA passion project combining <strong style="color:#F7F4EC">agriculture</strong>,
    <strong style="color:#F7F4EC">AI</strong>,
    <strong style="color:#F7F4EC">sustainability</strong>, and
    <strong style="color:#F7F4EC">Ukraine recovery</strong>.
  </p>
  <p class="footer-disclaimer">
    Disclaimer: This MVP uses simplified demo logic and synthetic data to validate the product concept
    before integration with real agricultural datasets. It does not constitute agronomic advice.
    Consult a certified agronomist before making planting decisions.
  </p>
  <div class="footer-copy">© 2025 AgroPredict Ukraine &nbsp;·&nbsp; MVP v1.0</div>
</div>
""", unsafe_allow_html=True)
