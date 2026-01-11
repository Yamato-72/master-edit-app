document.addEventListener("DOMContentLoaded", () => {
  // tabs / panels
  const tabs = document.querySelectorAll(".tab");
  const panels = document.querySelectorAll(".panel");

  // デバッグ（あとで消してOK）
  console.log("tabs:", tabs.length, "panels:", panels.length);

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      panels.forEach((p) => p.classList.add("hidden"));

      tab.classList.add("active");

      const target = tab.dataset.target;
      const panel = document.querySelector(`.panel[data-panel="${target}"]`);

      if (panel) {
        panel.classList.remove("hidden");
      } else {
        console.warn("panel not found:", target);
      }
    });
  });

  // toggle is_active
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest(".toggle-active-btn");
    if (!btn) return;

    const table = btn.dataset.table;
    const id = btn.dataset.id;

    btn.disabled = true;
    const prevText = btn.textContent;
    btn.textContent = "更新中...";

    try {
      const res = await fetch("/toggle-active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ table, id }),
      });

      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "更新に失敗しました");
        return;
      }

      const tr = btn.closest("tr");
      const badge = tr.querySelector(".badge");
      const isActive = Number(data.is_active) === 1;

      tr.classList.toggle("inactive-row", !isActive);
      badge.textContent = isActive ? "ON" : "OFF";
      badge.classList.toggle("on", isActive);
      badge.classList.toggle("off", !isActive);

      btn.textContent = isActive ? "無効にする" : "有効にする";
    } catch (err) {
      alert("通信エラー");
      btn.textContent = prevText;
    } finally {
      btn.disabled = false;
    }
  });
});
