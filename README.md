# AgroPredict Ukraine
### AI-powered crop suitability intelligence for Ukrainian farmland

---

## Overview

AgroPredict Ukraine is an agricultural decision-support platform that helps Ukrainian farmers and agribusinesses estimate crop suitability before planting. By analyzing soil type, historical yield performance, regional drought risk, and soil exhaustion indicators, the platform generates a data-driven success probability score for any crop-region combination.

This MVP was built as an MBA passion project at the intersection of agri-tech, climate resilience, and Ukraine's agricultural recovery.

---

## The Problem

Ukraine is one of the world's most important agricultural producers, supplying a significant share of global wheat, corn, and sunflower oil. Yet farmers — particularly smallholders and mid-sized agribusinesses — often make planting decisions based on habit, anecdote, or incomplete regional data.

Key challenges:
- **No accessible tool** for estimating crop suitability before the season
- **Soil exhaustion** is widely underestimated, especially after intensive sunflower and corn cycles
- **Drought risk** is increasing across southern and eastern oblasts due to climate trends
- **Post-conflict recovery** demands efficient, high-return planting decisions to restore output

---

## The Solution

AgroPredict Ukraine provides a clean, fast, and accessible interface for:

1. **Selecting a Ukrainian oblast and crop** to analyze
2. **Factoring in previous crop rotation** to estimate soil exhaustion impact
3. **Generating a success probability score** based on soil quality, yield history, drought exposure, and crop-specific indicators
4. **Receiving an AI-style recommendation** with risk factors and next steps
5. **Visualizing regional suitability** across all major Ukrainian oblasts via a heatmap

---

## Target Users

- Ukrainian farm managers and agribusiness operators
- Agricultural cooperatives and land management companies
- Impact investors and development organizations focused on Ukrainian agriculture
- NGOs supporting post-conflict agricultural recovery
- Agronomic consultants needing a quick regional screening tool

---

## MVP Features

| Feature | Status |
|---|---|
| Oblast-level crop suitability calculator | ✅ Live |
| 5 crop types: Wheat, Corn, Sunflower, Soybean, Rapeseed | ✅ Live |
| Previous crop rotation input | ✅ Live |
| Rule-based scoring model | ✅ Live |
| Regional heatmap visualization | ✅ Live |
| AI-style recommendation engine | ✅ Live |
| Key risk factors and next steps | ✅ Live |
| Optional GPS coordinates and field size input | ✅ Live |
| 15 Ukrainian oblasts with demo data | ✅ Live |

---

## Business Value

- **Reduce uncertainty** before committing seed, fertilizer, and labor investment
- **Improve crop selection** by comparing suitability across multiple crops per region
- **Protect soil health** through exhaustion-aware rotation planning
- **Support Ukraine's recovery** by enabling more efficient, sustainable planting decisions at scale

---

## Technical Stack

| Layer | Technology |
|---|---|
| UI / Frontend | Streamlit |
| Data processing | pandas |
| Visualization | Plotly |
| Scoring engine | Python (rule-based) |
| Data | CSV demo datasets |
| Deployment | Local / Streamlit Cloud |

---

## Scoring Model

The scoring engine (`scoring.py`) uses a transparent, rule-based approach:

```
success_probability =
    region base_score
  + crop base_crop_score
  + yield index bonus     (+12 high / +5 medium / -5 low)
  - drought risk penalty  (-8 medium / -18 high)
  - water demand × drought penalty  (if crop water_need=high and drought=medium/high)
  + chernozem soil bonus  (+8 if soil_type = Chernozem)
  - previous crop exhaustion penalty  (Sunflower: -15 / Soybean: +5 bonus / Corn: -8 / etc.)
  → clamped to [0, 100]
```

Soil exhaustion score is calculated separately based on the crop's exhaustion impact category and previous crop penalty, also clamped to [0, 100].

Labels:
- **75–100%** → High Suitability
- **55–74%** → Moderate Suitability
- **35–54%** → Risky
- **0–34%** → Low Suitability

---

## Roadmap

### Stage 1 — MVP (Current)
- Oblast-level calculator with rule-based scoring
- Demo data for 15 Ukrainian oblasts and 5 crops
- Visual regional heatmap and AI-style recommendations

### Stage 2 — Coordinate-Based Analysis (Next 6 months)
- GPS latitude/longitude field input
- Automatic region and micro-climate detection
- Granular soil and climate sub-indicators
- Multi-season crop rotation planner
- PDF report export

### Stage 3 — Field Intelligence (12–18 months)
- Sentinel-2 satellite imagery integration
- Historical climate time-series (ERA5)
- Real soil datasets (OpenLandMap, ISRIC World Soil Database)
- Machine learning prediction model (XGBoost or LightGBM)
- 10 km radius field-level intelligence engine

---

## Ukraine Recovery Relevance

Ukraine's agricultural sector accounts for approximately 10% of GDP and 40% of export revenue. The 2022–2024 conflict severely disrupted planting schedules, supply chains, and land accessibility. As recovery accelerates, farmers and agribusinesses need tools that help them:

- Prioritize high-probability crops on available land
- Rebuild soil health after years of disruption and expedient planting choices
- Make efficient, evidence-informed decisions that maximize recovery investment

AgroPredict Ukraine is designed to be a practical first step toward that goal.

---

## Running Locally

```bash
git clone https://github.com/your-username/agropredict-ukraine
cd agropredict-ukraine
pip install -r requirements.txt
streamlit run app.py
```

---

## Project Structure

```
agropredict-ukraine/
├── app.py          # Streamlit application (UI + layout)
├── scoring.py      # Rule-based scoring model
├── requirements.txt
├── README.md
└── data/
    ├── regions.csv # Oblast-level soil, yield, drought data
    └── crops.csv   # Crop water need and soil exhaustion data
```

---

## Disclaimer

This MVP uses simplified demo data and rule-based logic to validate the product concept. It is not connected to real-time agricultural databases, satellite data, or certified agronomic models. Do not use this tool as the sole basis for planting decisions. Consult a certified agronomist and regional agricultural authority before committing to a crop plan.

---

*Built as an MBA passion project · AgroPredict Ukraine v1.0 · 2025*
