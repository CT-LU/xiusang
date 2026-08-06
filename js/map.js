"use strict";
/**
 * Leaflet 地図表示。CDN 不達（window.L なし）の場合は「地図不可用」を表示するだけで、
 * 分配機能自体はオフラインで完全動作する。
 */
const MapView = (() => {
  let map = null;
  let overlay = null;

  function available() { return typeof window !== "undefined" && !!window.L && !!map; }

  function init() {
    const el = document.getElementById("map");
    if (!window.L) {
      el.innerHTML = '<div class="map-unavailable">地圖不可用（離線）<br><span class="ja">地図を利用できません（オフライン）</span></div>';
      return false;
    }
    map = L.map("map").setView([35.772, 140.355], 12);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);

    for (const t of TERMINALS) {
      L.marker([t.lat, t.lng], {
        icon: L.divIcon({ className: "terminal-icon", html: "✈", iconSize: [28, 28], iconAnchor: [14, 14] })
      }).addTo(map).bindTooltip(`成田空港 ${t.nameJa}`, { direction: "top" });
    }
    overlay = L.layerGroup().addTo(map);
    return true;
  }

  function markerColor(asg) {
    if (asg.totalPax === 0) return "#9aa0a6";
    return asg.needsPhoneConfirm ? "#f9ab00" : "#188038";
  }

  function popupHtml(asg) {
    const h = asg.hotel;
    const vac = I18N.vacancyLabel(asg.vacancyTier);
    const batches = asg.busBatches
      .map(b => `#${b.batch}: ${b.pax}名 T+${b.departOffsetMin}分`).join("<br>");
    return `
      <div class="popup">
        <strong>${h.nameJa}</strong><br>
        分配 <b>${asg.totalPax}</b> 人 / ${asg.totalRooms} 房
        <span class="ja">（割当 ${asg.totalPax}名 / ${asg.totalRooms}室）</span><br>
        巴士 ${asg.busCount} 台 <span class="ja">バス${asg.busCount}台</span><br>
        ${batches ? batches + "<br>" : ""}
        線上空房/空室: ${vac.zh}<br>
        車程 ${h.driveMinutes} 分 ・ <a href="tel:${h.phone}">${h.phone}</a>
        ${asg.needsPhoneConfirm ? '<br><span class="warn-text">⚠ 需電話確認 / 電話で要確認</span>' : ""}
      </div>`;
  }

  /** 分配結果で地図を再描画（計算のたびに呼ぶ） */
  function update(assignments) {
    if (!available()) return;
    overlay.clearLayers();
    for (const asg of assignments) {
      const h = asg.hotel;
      const color = markerColor(asg);
      if (asg.totalPax > 0) {
        L.polyline([[AIRPORT_CENTER.lat, AIRPORT_CENTER.lng], [h.lat, h.lng]], {
          color, weight: Math.min(10, 1 + asg.totalPax / 40), opacity: 0.5
        }).addTo(overlay);
      }
      L.circleMarker([h.lat, h.lng], {
        radius: asg.totalPax > 0 ? Math.min(26, 7 + Math.sqrt(asg.totalPax) * 1.3) : 5,
        color, fillColor: color, fillOpacity: 0.75, weight: 2
      }).addTo(overlay)
        .bindTooltip(`${h.nameJa}（${asg.totalPax}名）`, { direction: "top" })
        .bindPopup(popupHtml(asg), { maxWidth: 280 });
    }
  }

  return { init, update };
})();
