"use strict";
/**
 * エントリポイント：フォーム ↔ Allocator ↔ 結果表/地図/警示帯 の接続。
 * 「計算配分」はまずオフラインで即座に結果を出し、楽天照会は非同期で後追い更新する。
 */
(() => {
  const $ = id => document.getElementById(id);
  const LS_OVERRIDES = "narita.hotelOverrides.v1";

  let lastResult = null;
  let probeSeq = 0; // 古い非同期照会が新しい計算結果を上書きしないためのトークン

  // ---------- ホテル上書き（除外・可用室数）の保存 ----------
  function loadOverrides() {
    try { return JSON.parse(localStorage.getItem(LS_OVERRIDES) || "{}"); } catch (e) { return {}; }
  }
  function saveOverrides(ov) {
    try { localStorage.setItem(LS_OVERRIDES, JSON.stringify(ov)); } catch (e) { /* ignore */ }
  }

  function effectiveHotels() {
    const ov = loadOverrides();
    return HOTELS
      .filter(h => !(ov[h.id] && ov[h.id].excluded))
      .map(h => Object.assign({}, h, {
        usableRooms: ov[h.id] && ov[h.id].usableRooms !== undefined ? ov[h.id].usableRooms : h.usableRooms
      }));
  }

  // ---------- 入力 ----------
  function readInput() {
    const num = (id, def) => {
      const v = parseInt($(id).value, 10);
      return Number.isFinite(v) && v >= 0 ? v : def;
    };
    return {
      totalPax: num("totalPax", 0),
      premiumPax: num("premiumPax", 0),
      familyGroups: num("familyGroups", 0),
      familyAvgSize: Math.max(1, num("familyAvgSize", 3)),
      wheelchairPax: num("wheelchairPax", 0),
      crewCount: num("crewCount", 0),
      busCapacity: Math.max(1, num("busCapacity", 45)),
      busesAvailable: Math.max(1, num("busesAvailable", 6)),
      checkinDate: $("checkinDate").value || new Date().toISOString().slice(0, 10),
      occupancy: DEFAULTS.occupancy
    };
  }

  // ---------- 描画 ----------
  function bilingual(msg) {
    return `<span class="zh">${msg.zh}</span><span class="ja">${msg.ja}</span>`;
  }

  function renderValidation(result, extra) {
    const box = $("validation");
    box.innerHTML = "";
    const items = [...result.validation, ...(extra || [])];
    const order = { error: 0, warn: 1, info: 2 };
    items.sort((a, b) => order[a.severity] - order[b.severity]);
    for (const v of items) {
      const div = document.createElement("div");
      div.className = `alert alert-${v.severity}`;
      div.innerHTML = bilingual(I18N.t(v.code, v.params));
      box.appendChild(div);
    }
  }

  function batchesText(asg) {
    return asg.busBatches
      .map(b => `#${b.batch} ${b.pax}名 T+${b.departOffsetMin}′`)
      .join("<br>");
  }

  function renderTable(result) {
    const ov = loadOverrides();
    const tbody = $("resultBody");
    tbody.innerHTML = "";
    const rows = [...result.assignments].sort((a, b) =>
      b.totalPax - a.totalPax || a.hotel.driveMinutes - b.hotel.driveMinutes);
    // 除外中のホテルも設定行として表示する
    const excluded = HOTELS.filter(h => ov[h.id] && ov[h.id].excluded);

    const mk = (asg, hotel, isExcluded) => {
      const h = hotel;
      const b = asg ? asg.breakdown : null;
      const vac = I18N.vacancyLabel(asg ? asg.vacancyTier : null);
      const tr = document.createElement("tr");
      tr.className = (asg && asg.needsPhoneConfirm ? "needs-phone " : "") +
                     (isExcluded ? "excluded " : "") +
                     (asg && asg.totalPax === 0 ? "zero " : "");
      tr.innerHTML = `
        <td class="hotel-name">${h.nameJa}<br><small>${h.driveMinutes}分・tier${h.tier}${h.crewDesignated ? "・乗務員指定" : ""}</small></td>
        <td>${b ? b.crew.pax : "—"}</td>
        <td>${b ? b.premium.pax : "—"}</td>
        <td>${b ? `${b.family.groups}組/${b.family.pax}名` : "—"}</td>
        <td>${b ? b.accessible.pax : "—"}</td>
        <td>${b ? b.economy.pax : "—"}</td>
        <td class="total-cell">${asg ? `${asg.totalPax}名 / ${asg.totalRooms}室` : "—"}</td>
        <td class="vac-cell">${vac.zh}<br><small>${vac.ja}</small>${asg && asg.needsPhoneConfirm ? '<br><span class="warn-text">⚠ 要電話</span>' : ""}</td>
        <td>${asg && asg.busCount ? asg.busCount + "台" : "—"}</td>
        <td class="batches">${asg ? batchesText(asg) : ""}</td>
        <td><a href="tel:${h.phone}">${h.phone}</a><br><small>※要確認</small></td>
        <td><input type="number" class="ov-rooms" data-id="${h.id}" min="0" value="${(ov[h.id] && ov[h.id].usableRooms !== undefined) ? ov[h.id].usableRooms : h.usableRooms}"></td>
        <td><input type="checkbox" class="ov-exclude" data-id="${h.id}" ${isExcluded ? "checked" : ""}></td>`;
      return tr;
    };

    for (const asg of rows) tbody.appendChild(mk(asg, asg.hotel, false));
    for (const h of excluded) tbody.appendChild(mk(null, h, true));

    $("totCell").innerHTML =
      `${result.totals.pax}名 / ${result.totals.rooms}室 ・ 延べ${result.totals.trips}車次 ・ ` +
      `最終便帰着 T+${result.totals.lastReturnMin}分`;

    tbody.querySelectorAll(".ov-rooms").forEach(el => el.addEventListener("change", () => {
      const ov = loadOverrides();
      const id = el.dataset.id;
      ov[id] = ov[id] || {};
      ov[id].usableRooms = Math.max(0, parseInt(el.value, 10) || 0);
      saveOverrides(ov);
      calculate();
    }));
    tbody.querySelectorAll(".ov-exclude").forEach(el => el.addEventListener("change", () => {
      const ov = loadOverrides();
      const id = el.dataset.id;
      ov[id] = ov[id] || {};
      ov[id].excluded = el.checked;
      saveOverrides(ov);
      calculate();
    }));
  }

  /** 印刷用：ホテルごと 1 ページの乗車名簿ヘッダ */
  function renderPrintSheets(result) {
    const box = $("printSheets");
    box.innerHTML = "";
    for (const asg of result.assignments) {
      if (asg.totalPax === 0) continue;
      const div = document.createElement("div");
      div.className = "print-sheet";
      div.innerHTML = `
        <h2>${asg.hotel.nameJa}</h2>
        <p>分配 ${asg.totalPax}名 / ${asg.totalRooms}室 ・ バス${asg.busCount}台 ・ 車程${asg.hotel.driveMinutes}分 ・ TEL ${asg.hotel.phone}</p>
        <p>内訳：乗務員${asg.breakdown.crew.pax} / C・F ${asg.breakdown.premium.pax} / 家族${asg.breakdown.family.groups}組${asg.breakdown.family.pax}名 / 車椅子${asg.breakdown.accessible.pax} / 一般${asg.breakdown.economy.pax}</p>
        <table class="print-batches">
          <tr><th>便</th><th>人数</th><th>発車</th><th>担当者</th><th>点呼</th></tr>
          ${asg.busBatches.map(b =>
            `<tr><td>#${b.batch}</td><td>${b.pax}名</td><td>T+${b.departOffsetMin}分</td><td></td><td>　/　${b.pax}</td></tr>`).join("")}
        </table>`;
      box.appendChild(div);
    }
  }

  // ---------- 楽天照会（非同期後追い） ----------
  const TIER_LOWER = { 10: 10, 5: 5, 1: 1, 0: 0 };

  function setStatus(state, msg) {
    const light = $("statusLight");
    light.className = `status-light ${state}`;
    $("statusText").innerHTML = msg ? bilingual(msg) : "";
  }

  async function probeAndUpdate(result, checkinDate) {
    const seq = ++probeSeq;
    if (!RakutenAPI.getAppId()) {
      setStatus("offline", I18N.t("api-no-key"));
      renderValidation(result, [{ severity: "info", code: "offline-mode", params: {} }]);
      return;
    }
    setStatus("probing", I18N.t("api-probing"));
    try {
      const hotels = result.assignments.map(a => a.hotel);
      await RakutenAPI.resolveHotelNos(hotels);
      const tiers = await RakutenAPI.probeVacancy(hotels, checkinDate);
      if (seq !== probeSeq) return; // 既に再計算済み
      let withData = 0;
      for (const asg of result.assignments) {
        asg.vacancyTier = tiers[asg.hotelId];
        if (asg.vacancyTier !== null) withData++;
        asg.needsPhoneConfirm =
          asg.totalPax > 0 &&
          asg.vacancyTier !== null &&
          asg.totalRooms > TIER_LOWER[asg.vacancyTier];
      }
      setStatus("ok", I18N.t("api-ok"));
      renderTable(result);
      MapView.update(result.assignments);
      renderValidation(result, [
        { severity: "info", code: "api-probe-done", params: { n: withData } },
        { severity: "info", code: "vacancy-note", params: {} }
      ]);
    } catch (e) {
      if (seq !== probeSeq) return;
      setStatus("fail", I18N.t("api-fail", { msg: e.message }));
      renderValidation(result, [{ severity: "warn", code: "offline-mode", params: {} }]);
    }
  }

  // ---------- 計算 ----------
  function calculate() {
    const input = readInput();
    const hotels = effectiveHotels();
    lastResult = Allocator.allocate(input, hotels);
    renderValidation(lastResult);
    renderTable(lastResult);
    renderPrintSheets(lastResult);
    MapView.update(lastResult.assignments);
    probeAndUpdate(lastResult, input.checkinDate); // 非阻塞
  }

  // ---------- 初期化 ----------
  function initForm() {
    for (const [id, val] of Object.entries({
      totalPax: DEFAULTS.totalPax, premiumPax: DEFAULTS.premiumPax,
      familyGroups: DEFAULTS.familyGroups, familyAvgSize: DEFAULTS.familyAvgSize,
      wheelchairPax: DEFAULTS.wheelchairPax, crewCount: DEFAULTS.crewCount,
      busCapacity: DEFAULTS.busCapacity, busesAvailable: DEFAULTS.busesAvailable
    })) $(id).value = val;
    $("checkinDate").value = new Date().toISOString().slice(0, 10);
    $("appId").value = RakutenAPI.getAppId();
  }

  async function testApiKey() {
    RakutenAPI.setAppId($("appId").value);
    if (!RakutenAPI.getAppId()) { setStatus("offline", I18N.t("api-no-key")); return; }
    setStatus("probing", I18N.t("api-probing"));
    try {
      const ok = await RakutenAPI.testKey();
      setStatus(ok ? "ok" : "fail", ok ? I18N.t("api-ok") : I18N.t("api-fail", { msg: "no data" }));
    } catch (e) {
      setStatus("fail", I18N.t("api-fail", { msg: e.message }));
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    initForm();
    MapView.init();
    setStatus(RakutenAPI.getAppId() ? "idle" : "offline",
      RakutenAPI.getAppId() ? null : I18N.t("api-no-key"));

    $("calcBtn").addEventListener("click", calculate);
    $("printBtn").addEventListener("click", () => window.print());
    $("saveKeyBtn").addEventListener("click", testApiKey);
    $("inputForm").addEventListener("submit", e => { e.preventDefault(); calculate(); });

    if (new URLSearchParams(location.search).get("selftest") === "1") {
      calculate(); // selftest 時はデフォルト値で E2E スモークも実行
      const r = Allocator.runSelfTests();
      const div = document.createElement("div");
      div.className = `alert ${r.passed ? "alert-info" : "alert-error"}`;
      div.textContent = `[selftest] ${r.passed ? "ALL PASS" : "FAILED: " + r.failures.join(" | ")}`;
      $("validation").appendChild(div);
    }
  });
})();
