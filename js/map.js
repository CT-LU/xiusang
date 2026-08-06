"use strict";
/**
 * Leaflet 地図表示。CDN 不達（window.L なし）の場合は「地図不可用」を表示するだけで、
 * 分配機能自体はオフラインで完全動作する。
 *
 * update(items) の item: { hotel, asg|null, state: "assigned"|"zero"|"excluded"|"outrange" }
 * ポップアップの「使用/除外」ボタンは window.toggleHotel(id)（app.js 定義）を呼ぶ。
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
    map = L.map("map").setView([35.745, 140.28], 11);
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

  const STYLE = {
    assigned: { color: "#188038", fillOpacity: 0.75, dashArray: null },
    phone:    { color: "#f9ab00", fillOpacity: 0.75, dashArray: null },
    zero:     { color: "#9aa0a6", fillOpacity: 0.6,  dashArray: null },
    excluded: { color: "#d93025", fillOpacity: 0.15, dashArray: "4 3" },
    outrange: { color: "#9aa0a6", fillOpacity: 0.1,  dashArray: "2 4" }
  };

  function styleOf(item) {
    if (item.state === "assigned" && item.asg.needsPhoneConfirm) return STYLE.phone;
    return STYLE[item.state] || STYLE.zero;
  }

  function toggleButton(item) {
    const excluded = item.state === "excluded";
    return `<button class="popup-toggle ${excluded ? "include" : "exclude"}"
      onclick="window.toggleHotel('${item.hotel.id}')">
      ${excluded ? "使用する｜納入分配" : "除外する｜排除此飯店"}</button>`;
  }

  function popupHtml(item) {
    const h = item.hotel;
    const head = `<strong>${h.nameJa}</strong><br>車程 ${h.driveMinutes} 分 ・ <a href="tel:${h.phone}">${h.phone}</a><br>`;
    if (item.state === "outrange") {
      return `<div class="popup">${head}<span class="dim-text">検索範囲外（範囲を拡大すると候補になります）<br>在目前距離範圍外，擴大範圍後才會納入</span></div>`;
    }
    if (item.state === "excluded") {
      return `<div class="popup">${head}<span class="dim-text">除外中 / 已排除</span><br>${toggleButton(item)}</div>`;
    }
    const asg = item.asg;
    const vac = I18N.vacancyLabel(asg.vacancyTier);
    const batches = asg.busBatches
      .map(b => `#${b.batch}: ${b.pax}名 T+${b.departOffsetMin}分`).join("<br>");
    return `
      <div class="popup">
        ${head}
        分配 <b>${asg.totalPax}</b> 人 / ${asg.totalRooms} 房
        <span class="ja">（割当 ${asg.totalPax}名 / ${asg.totalRooms}室）</span><br>
        巴士 ${asg.busCount} 台 <span class="ja">バス${asg.busCount}台</span><br>
        ${batches ? batches + "<br>" : ""}
        線上空房/空室: ${vac.zh}<br>
        ${asg.needsPhoneConfirm ? '<span class="warn-text">⚠ 需電話確認 / 電話で要確認</span><br>' : ""}
        ${toggleButton(item)}
      </div>`;
  }

  /** 全ホテルを状態付きで再描画（計算のたびに呼ぶ） */
  function update(items) {
    if (!available()) return;
    overlay.clearLayers();
    for (const item of items) {
      const h = item.hotel;
      const s = styleOf(item);
      const pax = item.asg ? item.asg.totalPax : 0;
      if (pax > 0) {
        L.polyline([[AIRPORT_CENTER.lat, AIRPORT_CENTER.lng], [h.lat, h.lng]], {
          color: s.color, weight: Math.min(10, 1 + pax / 40), opacity: 0.5
        }).addTo(overlay);
      }
      L.circleMarker([h.lat, h.lng], {
        radius: pax > 0 ? Math.min(26, 7 + Math.sqrt(pax) * 1.3) : 5,
        color: s.color, fillColor: s.color, fillOpacity: s.fillOpacity,
        weight: 2, dashArray: s.dashArray
      }).addTo(overlay)
        .bindTooltip(`${h.nameJa}（${pax}名）`, { direction: "top" })
        .bindPopup(popupHtml(item), { maxWidth: 300 });
    }
  }

  return { init, update };
})();
