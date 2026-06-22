import pandas as pd

PREVIOUS_CROP_EXHAUSTION = {
    "None": 0,
    "Wheat": 5,
    "Corn": 8,
    "Sunflower": 15,
    "Soybean": -5,
    "Rapeseed": 7,
}

YIELD_INDEX_BONUS = {"high": 12, "medium": 5, "low": -5}
DROUGHT_RISK_PENALTY = {"low": 0, "medium": -8, "high": -18}
WATER_NEED_DROUGHT_PENALTY = {"low": 0, "medium": -5, "high": -12}
SOIL_EXHAUSTION_IMPACT_MAP = {"low": 10, "medium": 30, "high": 55}


def calculate_score(region_row: pd.Series, crop_row: pd.Series, previous_crop: str) -> dict:
    score = region_row["base_score"]
    score += crop_row["base_crop_score"]

    score += YIELD_INDEX_BONUS.get(region_row["average_yield_index"], 0)
    score += DROUGHT_RISK_PENALTY.get(region_row["drought_risk"], 0)

    if region_row["drought_risk"] in ("medium", "high") and crop_row["water_need"] == "high":
        score += WATER_NEED_DROUGHT_PENALTY[region_row["drought_risk"]]

    if region_row["soil_type"] == "Chernozem":
        score += 8

    prev_penalty = PREVIOUS_CROP_EXHAUSTION.get(previous_crop, 0)
    score -= prev_penalty

    success_probability = max(0, min(100, int(score)))

    base_exhaustion = SOIL_EXHAUSTION_IMPACT_MAP.get(crop_row["soil_exhaustion_impact"], 30)
    exhaustion_adjustment = prev_penalty * 1.5
    soil_exhaustion_score = max(0, min(100, int(base_exhaustion + exhaustion_adjustment)))

    if success_probability >= 75:
        suitability_label = "High Suitability"
    elif success_probability >= 55:
        suitability_label = "Moderate Suitability"
    elif success_probability >= 35:
        suitability_label = "Risky"
    else:
        suitability_label = "Low Suitability"

    recommendation = _build_recommendation(
        crop_row["crop"], region_row, crop_row, success_probability, soil_exhaustion_score
    )

    key_risk_factors = _build_risk_factors(region_row, crop_row, previous_crop)
    suggested_next_steps = _build_next_steps(region_row, crop_row, success_probability)

    return {
        "success_probability": success_probability,
        "soil_exhaustion_score": soil_exhaustion_score,
        "suitability_label": suitability_label,
        "recommendation": recommendation,
        "key_risk_factors": key_risk_factors,
        "suggested_next_steps": suggested_next_steps,
        "soil_type": region_row["soil_type"],
        "drought_risk": region_row["drought_risk"],
        "average_yield_index": region_row["average_yield_index"],
    }


def _build_recommendation(crop, region_row, crop_row, prob, exhaustion):
    soil = region_row["soil_type"]
    drought = region_row["drought_risk"]
    yield_idx = region_row["average_yield_index"]
    water = crop_row["water_need"]
    ex_impact = crop_row["soil_exhaustion_impact"]

    parts = []

    if prob >= 75:
        parts.append(
            f"{crop} appears well-suited for this region, benefiting from {soil} soil"
            f" and {yield_idx} historical yield performance."
        )
    elif prob >= 55:
        parts.append(
            f"{crop} shows moderate potential in this region. {soil} soil provides"
            f" a reasonable foundation, though conditions are not optimal."
        )
    else:
        parts.append(
            f"{crop} faces significant challenges in this region."
            f" {soil} soil and {yield_idx} yield history limit expected performance."
        )

    if drought in ("medium", "high") and water in ("medium", "high"):
        parts.append(
            f"Drought risk is {drought} and this crop has {water} water demands —"
            " irrigation planning is strongly recommended."
        )
    elif drought == "high":
        parts.append("High regional drought risk warrants careful water management regardless of crop choice.")

    if ex_impact == "high" or exhaustion > 50:
        parts.append(
            "Soil exhaustion impact is notable. Rotating with a nitrogen-fixing crop"
            " such as soybean next season will help restore soil health."
        )
    elif ex_impact == "low":
        parts.append("This crop has relatively low soil exhaustion impact, supporting long-term field sustainability.")

    return " ".join(parts)


def _build_risk_factors(region_row, crop_row, previous_crop):
    factors = []
    drought = region_row["drought_risk"]
    water = crop_row["water_need"]
    ex_impact = crop_row["soil_exhaustion_impact"]

    if drought in ("medium", "high"):
        factors.append(f"Drought risk: {drought.capitalize()} — regional moisture deficit possible")
    if water == "high":
        factors.append(f"Crop water demand: High — {crop_row['crop']} requires significant irrigation support")
    if ex_impact == "high":
        factors.append("Soil nutrient depletion: High — this crop significantly depletes soil nutrients")
    elif ex_impact == "medium":
        factors.append("Soil nutrient depletion: Moderate — monitor nitrogen and phosphorus levels")
    if previous_crop in ("Sunflower", "Corn"):
        factors.append(f"Previous crop impact: {previous_crop} leaves residue that may increase disease pressure")
    if region_row["average_yield_index"] == "low":
        factors.append("Historical yield: Low regional yield history increases uncertainty")

    if not factors:
        factors.append("No critical risk factors identified — conditions appear favorable")

    return factors


def _build_next_steps(region_row, crop_row, prob):
    steps = [
        "Compare success probability with alternative crops using the calculator above",
        "Review a multi-season crop rotation plan to protect long-term soil health",
    ]
    if region_row["drought_risk"] in ("medium", "high"):
        steps.append("Consult a local agronomist about irrigation strategy and drought mitigation")
    steps.append("Monitor regional drought indicators through Ukraine's Hydrometeorological Center")
    if prob < 60:
        steps.append("Consider testing a small trial plot before committing full field acreage")
    return steps
