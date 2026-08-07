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
  let lastItems = [];      // 範囲選択の判定に使う（update のたびに更新）
  let selectMode = false;
  let dragStart = null;
  let box = null;          // ドラッグ中のプレビュー矩形
  let selectHandler = null;

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

    // 範囲選択はマウスとタッチ（現場のタブレット）を同じ経路で扱うため pointer イベントを使う。
    // Leaflet の map.on("mousedown") はタッチのドラッグ中に発火しない。
    const c = map.getContainer();
    c.addEventListener("pointerdown", onPointerDown);
    c.addEventListener("pointermove", onPointerMove);
    c.addEventListener("pointerup", onPointerUp);
    c.addEventListener("pointercancel", onPointerUp);
    return true;
  }

  // ---------- 範囲選択 ----------
  function eventLatLng(ev) {
    const r = map.getContainer().getBoundingClientRect();
    return map.containerPointToLatLng(L.point(ev.clientX - r.left, ev.clientY - r.top));
  }

  function clearBox() {
    if (box) { map.removeLayer(box); box = null; }
  }

  function onPointerDown(ev) {
    if (!selectMode) return;
    ev.preventDefault();
    clearBox();
    dragStart = eventLatLng(ev);
    // ポインタを捕捉して地図の外で指を離しても mouseup を取りこぼさない
    try { map.getContainer().setPointerCapture(ev.pointerId); } catch (e) { /* 非対応環境は無視 */ }
  }

  function onPointerMove(ev) {
    if (!selectMode || !dragStart) return;
    ev.preventDefault();
    const b = L.latLngBounds(dragStart, eventLatLng(ev));
    if (box) box.setBounds(b);
    else box = L.rectangle(b, { color: "#1565c0", weight: 2, dashArray: "5 4", fillOpacity: 0.08 }).addTo(map);
  }

  function onPointerUp(ev) {
    if (!selectMode || !dragStart) return;
    dragStart = null;
    try { map.getContainer().releasePointerCapture(ev.pointerId); } catch (e) { /* 同上 */ }
    if (!box) return;  // ドラッグせず離した＝ただのクリック
    const b = box.getBounds();
    const ids = lastItems
      .filter(it => b.contains(L.latLng(it.hotel.lat, it.hotel.lng)))
      .map(it => it.hotel.id);
    if (ids.length === 0) clearBox();
    if (selectHandler) selectHandler(ids);
  }

  /** 範囲選択モードの ON/OFF。ON の間は地図のドラッグ移動を止める */
  function setSelectMode(on) {
    if (!available()) return;
    selectMode = !!on;
    dragStart = null;
    clearBox();
    map.getContainer().classList.toggle("box-select", selectMode);
    if (selectMode) { map.dragging.disable(); map.doubleClickZoom.disable(); }
    else { map.dragging.enable(); map.doubleClickZoom.enable(); }
  }

  /** 囲まれたホテル id 配列を受け取るコールバックを登録（app.js が使う） */
  function onBoxSelect(fn) { selectHandler = fn; }

  /**
   * line   = 空港からの接続線の色
   * stroke = 円の輪郭（白フチで地図タイルから浮かせる）
   * fill   = 円の塗り / minRadius = 未割当時の半径
   */
  const STYLE = {
    // 緑は OSM の森林・公園と同化するため使わない（濃青＝割当済み）
    assigned: { line: "#1565c0", stroke: "#ffffff", fill: "#1565c0", fillOpacity: 0.9,  weight: 2,   dashArray: null,  minRadius: 8 },
    phone:    { line: "#f9ab00", stroke: "#ffffff", fill: "#f9ab00", fillOpacity: 0.95, weight: 2,   dashArray: null,  minRadius: 8 },
    zero:     { line: "#3c4043", stroke: "#ffffff", fill: "#3c4043", fillOpacity: 0.95, weight: 2,   dashArray: null,  minRadius: 8 },
    excluded: { line: "#d93025", stroke: "#d93025", fill: "#d93025", fillOpacity: 0.2,  weight: 2.5, dashArray: "4 3", minRadius: 8 },
    outrange: { line: "#9aa0a6", stroke: "#80868b", fill: "#c8ccd0", fillOpacity: 0.55, weight: 2,   dashArray: "3 3", minRadius: 7 }
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
    if (!asg || asg.totalPax === 0) {
      return `<div class="popup">${head}<span class="dim-text">未割当 / 未分配</span><br>${toggleButton(item)}</div>`;
    }
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
    lastItems = items;
    overlay.clearLayers();
    for (const item of items) {
      const h = item.hotel;
      const s = styleOf(item);
      const pax = item.asg ? item.asg.totalPax : 0;
      if (pax > 0) {
        L.polyline([[AIRPORT_CENTER.lat, AIRPORT_CENTER.lng], [h.lat, h.lng]], {
          color: s.line, weight: Math.min(10, 1 + pax / 40), opacity: 0.5
        }).addTo(overlay);
      }
      L.circleMarker([h.lat, h.lng], {
        radius: pax > 0 ? Math.min(26, 7 + Math.sqrt(pax) * 1.3) : s.minRadius,
        color: s.stroke, fillColor: s.fill, fillOpacity: s.fillOpacity,
        weight: s.weight, dashArray: s.dashArray
      }).addTo(overlay)
        .bindTooltip(`${h.nameJa}（${pax}名）`, { direction: "top" })
        .bindPopup(popupHtml(item), { maxWidth: 300 });
    }
  }

  /** 収合→展開後にタイルレイアウトを再計算（Leaflet はコンテナサイズ変化を自動検知しない） */
  function invalidate() { if (available()) setTimeout(() => map.invalidateSize(), 50); }

  return { init, update, invalidate, setSelectMode, onBoxSelect };
})();
