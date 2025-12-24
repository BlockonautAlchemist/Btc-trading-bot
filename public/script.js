(() => {
  const titleEl = document.getElementById("title");
  const loadingEl = document.getElementById("loading");
  const contentEl = document.getElementById("content");
  const errorEl = document.getElementById("error");
  const directionEl = document.getElementById("direction");
  const confidenceEl = document.getElementById("confidence");
  const targetEl = document.getElementById("target");
  const reasoningEl = document.getElementById("reasoning");

  const showError = (msg) => {
    if (loadingEl) loadingEl.style.display = "none";
    if (contentEl) contentEl.style.display = "none";
    if (errorEl) {
      errorEl.style.display = "block";
      errorEl.textContent = msg;
    }
  };

  const showPrediction = (data) => {
    if (loadingEl) loadingEl.style.display = "none";
    if (errorEl) errorEl.style.display = "none";
    if (contentEl) contentEl.style.display = "block";

    const dateStr = data.timestamp
      ? new Date(data.timestamp).toLocaleString()
      : "Unknown";
    if (titleEl) titleEl.textContent = `BTC 24h Prediction (Updated ${dateStr})`;
    if (directionEl) directionEl.textContent = data.direction ?? "--";
    if (confidenceEl)
      confidenceEl.textContent =
        data.confidence !== undefined ? `${data.confidence}%` : "--";
    if (targetEl)
      targetEl.textContent =
        data.targetPrice !== undefined ? `$${data.targetPrice}` : "--";
    if (reasoningEl) reasoningEl.textContent = data.reasoning ?? "--";
  };

  const load = async () => {
    try {
      const res = await fetch("./prediction.json", { cache: "no-cache" });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      showPrediction(data);
    } catch (err) {
      console.error("Failed to load prediction:", err);
      showError("No prediction available yet. Please check back later.");
    }
  };

  load();
})();

