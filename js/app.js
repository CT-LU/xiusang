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

  function effectiveHotels(maxZone) {
    const ov = loadOverrides();
    return HOTELS
      .filter(h => h.zone <= maxZone && !(ov[h.id] && ov[h.id].excluded))
      .map(h => Object.assign({}, h, {
        usableRooms: ov[h.id] && ov[h.id].usableRooms !== undefined ? ov[h.id].usableRooms : h.usableRooms
      }));
  }

  /** 未安置が残っているか（入力矛盾は除外＝範囲拡大では解決しない） */
  function hasShortage(r) {
    if (r.validation.some(v => v.code === "input-invalid")) return false;
    const u = r.unassigned;
    return u.crew + u.accessible + u.familyPax + u.economy > 0;
  }

  /** 楽天同期済みの電話・総室数キャッシュを静的データに反映 */
  function applyFacts() {
    const facts = RakutenAPI.getFacts();
    for (const h of HOTELS) {
      const f = facts[h.id];
      if (!f) continue;
      if (f.phone) { h.phone = f.phone; h.phoneVerified = true; }
      if (f.rooms) { h.totalRooms = f.rooms; h.roomsVerified = true; }
    }
  }

  async function syncFacts() {
    if (!RakutenAPI.getAppId()) { setStatus("offline", I18N.t("api-no-key")); return; }
    try {
      await RakutenAPI.resolveHotelNos(HOTELS);
      const n = await RakutenAPI.syncHotelFacts(HOTELS, (done, total) =>
        setStatus("probing", I18N.t("sync-progress", { done, total })));
      applyFacts();
      setStatus("ok", I18N.t("sync-done", { n }));
      if (lastResult) calculate(); else refreshSelection();
    } catch (e) {
      setStatus("fail", I18N.t("api-fail", { msg: e.message }));
    }
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
        <td class="hotel-name">${h.nameJa}<br><small>${h.driveMinutes}分・tier${h.tier}・全${h.totalRooms}室${h.roomsVerified ? "✓" : "※"}${h.crewDesignated ? "・乗務員指定" : ""}</small></td>
        <td>${b ? b.crew.pax : "—"}</td>
        <td>${b ? b.premium.pax : "—"}</td>
        <td>${b ? `${b.family.groups}組/${b.family.pax}名` : "—"}</td>
        <td>${b ? b.accessible.pax : "—"}</td>
        <td>${b ? b.economy.pax : "—"}</td>
        <td class="total-cell">${asg ? `${asg.totalPax}名 / ${asg.totalRooms}室` : "—"}</td>
        <td class="vac-cell">${vac.zh}<br><small>${vac.ja}</small>${asg && asg.needsPhoneConfirm ? '<br><span class="warn-text">⚠ 要電話</span>' : ""}</td>
        <td>${asg && asg.busCount ? asg.busCount + "台" : "—"}</td>
        <td class="batches">${asg ? batchesText(asg) : ""}</td>
        <td><a href="tel:${h.phone}">${h.phone}</a><br><small>${h.phoneVerified ? "✓楽天" : "※要確認"}</small></td>
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

  function nowStamp() {
    const d = new Date(), p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /** 発車帯：初便〜最終便の T+ 分（1便なら 1 つだけ） */
  function departSpan(asg) {
    const bs = asg.busBatches;
    if (!bs.length) return "—";
    const first = bs[0].departOffsetMin, last = bs[bs.length - 1].departOffsetMin;
    return first === last ? `T+${first}` : `T+${first}〜+${last}`;
  }

  /**
   * 印刷 1 枚目：本社報告用サマリ。
   * 「何名をどこへ・バス何台・いつ終わる・何が未解決か」を 1 ページに集約する。
   * 便名と配車開始時刻 T の実時刻は入力項目に無いため手書き欄とする。
   */
  function overviewSheet(result, input, zone) {
    const rows = [...result.assignments]
      .filter(a => a.totalPax > 0)
      .sort((a, b) => a.hotel.driveMinutes - b.hotel.driveMinutes || b.totalPax - a.totalPax);
    const risks = result.validation.filter(v => v.severity !== "info");
    const u = result.unassigned;
    const unplaced = u.crew + u.accessible + u.familyPax + u.economy;
    const famPax = Allocator.buildFamilySizes(input.familyGroups, input.familyAvgSize)
      .reduce((a, b) => a + b, 0);
    const sum = pool => rows.reduce((a, r) => a + r.breakdown[pool].pax, 0);

    const div = document.createElement("div");
    div.className = "print-sheet print-overview";
    div.innerHTML = `
      <div class="ov-head">
        <h2>欠航対応 ホテル・バス配分計画（概要）<small>停飛住宿・巴士分配計劃總覽</small></h2>
        <div class="ov-stamp">成田空港 NRT<br>作成 ${nowStamp()}</div>
      </div>

      <table class="ov-cond">
        <tr>
          <th>便名 / 航班</th><td class="fill"></td>
          <th>宿泊日 / 住宿日</th><td>${input.checkinDate}</td>
          <th>配車開始 T / 發車起點</th><td class="fill">　　時　　分</td>
        </tr>
        <tr>
          <th>総旅客 / 總旅客</th><td>${input.totalPax}名</td>
          <th>内 C・F</th><td>${input.premiumPax}名</td>
          <th>乗務員 / 組員</th><td>${input.crewCount}名</td>
        </tr>
        <tr>
          <th>家族 / 家庭</th><td>${input.familyGroups}組 ${famPax}名</td>
          <th>車椅子 / 無障礙</th><td>${input.wheelchairPax}名</td>
          <th>バス / 巴士</th><td>${input.busCapacity}名 × ${input.busesAvailable}台</td>
        </tr>
        <tr>
          <th>手配範囲 / 範圍</th><td colspan="5">${ZONES[zone].ja}｜${ZONES[zone].zh}
            ${rows.length}軒使用 / 使用 ${rows.length} 家</td>
        </tr>
      </table>

      <div class="ov-kpis">
        <div class="kpi"><b>${result.totals.pax}</b><span>手配人数 / 安置人數</span></div>
        <div class="kpi"><b>${result.totals.rooms}</b><span>客室 / 房間數</span></div>
        <div class="kpi"><b>${rows.length}</b><span>ホテル / 飯店</span></div>
        <div class="kpi"><b>${result.totals.trips}</b><span>延べ車次 / 總車次</span></div>
        <div class="kpi"><b>T+${result.totals.lastReturnMin}</b><span>最終便帰着 / 末班回程</span></div>
        <div class="kpi ${unplaced ? "kpi-bad" : ""}"><b>${unplaced}</b><span>未手配 / 未安置</span></div>
      </div>

      <h3>要確認・リスク <span class="ja">待確認事項與風險</span></h3>
      <ul class="ov-risks">
        ${risks.length
          ? risks.map(v => {
              const m = I18N.t(v.code, v.params);
              return `<li class="risk-${v.severity}"><b>${v.severity === "error" ? "要対応" : "注意"}</b>
                ${m.ja}<br><span class="zh">${m.zh}</span></li>`;
            }).join("")
          : `<li class="risk-none">特記事項なし（全員手配済み）<br><span class="zh">無特別事項，全員安置完成</span></li>`}
      </ul>

      <h3>ホテル別 配分一覧 <span class="ja">各飯店分配明細</span></h3>
      <table class="ov-table${rows.length > 9 ? " dense" : ""}">
        <thead>
          <tr>
            <th class="l">ホテル / 飯店</th><th>車程</th><th>乗務員</th><th>C・F</th>
            <th>家族</th><th>車椅子</th><th>一般</th><th>計（名/室）</th>
            <th>バス</th><th>発車 T+分</th><th class="l">TEL</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(a => {
            const b = a.breakdown;
            return `<tr>
              <td class="l">${a.hotel.nameJa}${a.hotel.crewDesignated ? " <small>（乗務員指定）</small>" : ""}</td>
              <td>${a.hotel.driveMinutes}分</td>
              <td>${b.crew.pax || ""}</td>
              <td>${b.premium.pax || ""}</td>
              <td>${b.family.groups ? `${b.family.groups}組${b.family.pax}名` : ""}</td>
              <td>${b.accessible.pax || ""}</td>
              <td>${b.economy.pax || ""}</td>
              <td class="strong">${a.totalPax} / ${a.totalRooms}</td>
              <td>${a.busCount || ""}</td>
              <td>${departSpan(a)}</td>
              <td class="l tel">${a.hotel.phone}</td>
            </tr>`;
          }).join("")}
        </tbody>
        <tfoot>
          <tr>
            <th class="l">合計 / 總計</th><th></th>
            <th>${sum("crew")}</th><th>${sum("premium")}</th>
            <th>${rows.reduce((a, r) => a + r.breakdown.family.groups, 0)}組${sum("family")}名</th>
            <th>${sum("accessible")}</th><th>${sum("economy")}</th>
            <th class="strong">${result.totals.pax} / ${result.totals.rooms}</th>
            <th>${result.totals.trips}車次</th><th>T+${result.totals.lastReturnMin}帰着</th><th></th>
          </tr>
        </tfoot>
      </table>

      <p class="ov-note">
        ※「T+分」は配車開始時刻 T からの経過分。室数・空室は電話確認前の計画値です。
        <span class="zh">※「T+分」為發車起點 T 起算的分鐘數；房數與空房為電話確認前的計劃值。</span>
      </p>

      <table class="ov-sign">
        <tr><th>作成 / 製表</th><th>現場責任者 / 現場負責</th><th>本社確認 / 總部確認</th></tr>
        <tr><td></td><td></td><td></td></tr>
      </table>`;
    return div;
  }

  /** 印刷用：1 枚目に本社報告用サマリ、以降はホテルごと 1 ページの乗車名簿ヘッダ */
  function renderPrintSheets(result, input, zone) {
    const box = $("printSheets");
    box.innerHTML = "";
    box.appendChild(overviewSheet(result, input, zone));
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
      MapView.update(mapItems(result, result.usedZone || 3));
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
  /** 全ホテルを状態付きで地図へ渡す */
  function mapItems(result, usedZone) {
    const ov = loadOverrides();
    return HOTELS.map(h => {
      const asg = result.assignments.find(a => a.hotelId === h.id) || null;
      let state;
      if (asg) state = asg.totalPax > 0 ? "assigned" : "zero";
      else if (ov[h.id] && ov[h.id].excluded) state = "excluded";
      else state = h.zone > usedZone ? "outrange" : "zero";
      return { hotel: h, asg, state };
    });
  }

  function calculate() {
    const input = readInput();
    const selectedZone = parseInt($("rangeZone").value, 10) || 1;
    const autoExpand = $("autoExpand").checked;

    let zone = selectedZone;
    let result = Allocator.allocate(input, effectiveHotels(zone));
    while (autoExpand && zone < 3 && hasShortage(result)) {
      zone++;
      result = Allocator.allocate(input, effectiveHotels(zone));
    }
    if (zone !== selectedZone) {
      result.validation.push({ severity: "warn", code: "range-expanded",
        params: { label: `${ZONES[zone].zh}／${ZONES[zone].ja}` } });
    } else if (!autoExpand && zone < 3 && hasShortage(result)) {
      result.validation.push({ severity: "warn", code: "range-hint", params: {} });
    }

    lastResult = result;
    lastResult.usedZone = zone;
    renderValidation(lastResult);
    renderTable(lastResult);
    renderPrintSheets(lastResult, input, zone);
    renderPicker(zone);
    MapView.update(mapItems(lastResult, zone));
    probeAndUpdate(lastResult, input.checkinDate); // 非阻塞
  }

  /** 複数ホテルの使用/除外をまとめて更新（全選択・範囲選択の共通処理） */
  function setHotelsExcluded(ids, excluded) {
    const ov = loadOverrides();
    for (const id of ids) {
      ov[id] = ov[id] || {};
      ov[id].excluded = excluded;
    }
    saveOverrides(ov);
    refreshSelection();
  }

  // ---------- ホテル選択パネル ----------
  function renderPicker(usedZone) {
    const box = $("hotelPicker");
    const ov = loadOverrides();
    const isOn = h => !(ov[h.id] && ov[h.id].excluded);
    box.innerHTML = "";

    $("pickCount").innerHTML =
      `${HOTELS.filter(isOn).length}/${HOTELS.length} 選択中 <span class="ja">已勾選</span>`;

    for (const z of [1, 2, 3]) {
      const zoneHotels = HOTELS.filter(h => h.zone === z);
      const onCount = zoneHotels.filter(isOn).length;
      const group = document.createElement("div");
      group.className = "picker-group";

      // ゾーン見出し自体をチェックボックスにして、その圏だけ一括切替できるようにする
      const head = document.createElement("label");
      head.className = "picker-zone" + (z > usedZone ? " dim" : "");
      head.innerHTML = `<input type="checkbox" ${onCount === zoneHotels.length ? "checked" : ""}>
        <span class="picker-zone-name">${ZONES[z].ja}<span class="ja">${ZONES[z].zh}</span></span>
        <span class="picker-zone-count">${onCount}/${zoneHotels.length}</span>`;
      const headBox = head.querySelector("input");
      headBox.indeterminate = onCount > 0 && onCount < zoneHotels.length;
      headBox.addEventListener("change", e =>
        setHotelsExcluded(zoneHotels.map(h => h.id), !e.target.checked));
      group.appendChild(head);

      for (const h of zoneHotels) {
        const excluded = !!(ov[h.id] && ov[h.id].excluded);
        const rooms = ov[h.id] && ov[h.id].usableRooms !== undefined ? ov[h.id].usableRooms : h.usableRooms;
        const row = document.createElement("div");
        row.className = "picker-row" + (h.zone > usedZone ? " dim" : "");
        row.innerHTML = `
          <label class="picker-main">
            <input type="checkbox" data-id="${h.id}" ${excluded ? "" : "checked"}>
            <span class="picker-name">${h.nameJa}</span>
            <span class="picker-meta">${h.driveMinutes}分・${rooms}室</span>
          </label>
          <a class="picker-tel" href="tel:${h.phone}" title="${h.phoneVerified ? "楽天公式データ" : "要確認"}">${h.phone}${h.phoneVerified ? "✓" : ""}</a>`;
        row.querySelector("input").addEventListener("change",
          e => setHotelsExcluded([h.id], !e.target.checked));
        group.appendChild(row);
      }
      box.appendChild(group);
    }
  }

  /** 計算前でも全ホテルを地図に表示するための状態一覧 */
  function initialMapItems() {
    const ov = loadOverrides();
    const zone = parseInt($("rangeZone").value, 10) || 1;
    return HOTELS.map(h => ({
      hotel: h, asg: null,
      state: (ov[h.id] && ov[h.id].excluded) ? "excluded" : (h.zone > zone ? "outrange" : "zero")
    }));
  }

  /** 選択状態が変わったとき：計算済みなら再計算、未計算なら地図とパネルだけ更新 */
  function refreshSelection() {
    if (lastResult) { calculate(); return; }
    renderPicker(parseInt($("rangeZone").value, 10) || 1);
    MapView.update(initialMapItems());
  }

  /** 地図ポップアップの「使用/除外」ボタンから呼ばれる */
  window.toggleHotel = id => {
    const ov = loadOverrides();
    ov[id] = ov[id] || {};
    ov[id].excluded = !ov[id].excluded;
    saveOverrides(ov);
    refreshSelection();
  };

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
    // URL パラメータで上書き（シナリオのブックマークやテストに使用）
    const q = new URLSearchParams(location.search);
    for (const id of ["totalPax", "premiumPax", "familyGroups", "familyAvgSize",
                      "wheelchairPax", "crewCount", "busCapacity", "busesAvailable", "rangeZone"]) {
      if (q.has(id)) $(id).value = q.get(id);
    }
    if (q.has("autoExpand")) $("autoExpand").checked = q.get("autoExpand") !== "0";
    renderPicker(parseInt($("rangeZone").value, 10) || 1);
  }

  async function testApiKey() {
    RakutenAPI.setAppId($("appId").value);
    if (!RakutenAPI.getAppId()) { setStatus("offline", I18N.t("api-no-key")); return; }
    setStatus("probing", I18N.t("api-probing"));
    try {
      const ok = await RakutenAPI.testKey();
      setStatus(ok ? "ok" : "fail", ok ? I18N.t("api-ok") : I18N.t("api-fail", { msg: "no data" }));
      // key 有効かつ未同期なら、電話・総室数を自動で公式データに更新
      if (ok && Object.keys(RakutenAPI.getFacts()).length === 0) await syncFacts();
    } catch (e) {
      setStatus("fail", I18N.t("api-fail", { msg: e.message }));
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    applyFacts();
    initForm();
    const mapOk = MapView.init();
    MapView.update(initialMapItems()); // 計算前から全ホテルを表示（ポップアップで使用/除外可）
    setStatus(RakutenAPI.getAppId() ? "idle" : "offline",
      RakutenAPI.getAppId() ? null : I18N.t("api-no-key"));

    // 地図の収合/展開（状態は localStorage に保存）
    const LS_MAP = "narita.mapCollapsed";
    const applyMapState = collapsed => {
      $("mapPanel").classList.toggle("collapsed", collapsed);
      $("mapToggle").innerHTML = collapsed
        ? '地図を表示 ▼ <span class="ja">展開地圖</span>'
        : '地図を隠す ▲ <span class="ja">收合地圖</span>';
      if (!collapsed) MapView.invalidate();
    };
    applyMapState(localStorage.getItem(LS_MAP) === "1");
    $("mapToggle").addEventListener("click", () => {
      const collapsed = !$("mapPanel").classList.contains("collapsed");
      try { localStorage.setItem(LS_MAP, collapsed ? "1" : "0"); } catch (e) { /* ignore */ }
      applyMapState(collapsed);
    });

    // 地図のドラッグ範囲選択（囲んだホテルを一括で使用/除外）
    if (!mapOk) $("boxSelectBtn").hidden = true;
    let boxIds = [];
    const setBoxMode = on => {
      $("boxSelectBtn").classList.toggle("active", on);
      $("boxSelectBtn").innerHTML = on
        ? '選択を終了 ⬚ <span class="ja">結束框選</span>'
        : '範囲選択 ⬚ <span class="ja">框選多家飯店</span>';
      MapView.setSelectMode(on);
      if (!on) { boxIds = []; $("boxActions").hidden = true; }
    };
    MapView.onBoxSelect(ids => {
      boxIds = ids;
      $("boxActions").hidden = ids.length === 0;
      $("boxCount").innerHTML = `${ids.length} 件を選択 <span class="ja">已圈選 ${ids.length} 家</span>`;
    });
    const applyBox = excluded => {
      const ids = boxIds;
      setBoxMode(false);   // 適用後はモードを抜ける（連続適用より誤操作防止を優先）
      setHotelsExcluded(ids, excluded);
    };
    $("boxSelectBtn").addEventListener("click",
      () => setBoxMode(!$("boxSelectBtn").classList.contains("active")));
    $("boxInclude").addEventListener("click", () => applyBox(false));
    $("boxExclude").addEventListener("click", () => applyBox(true));
    $("boxCancel").addEventListener("click", () => setBoxMode(false));

    const allIds = () => HOTELS.map(h => h.id);
    $("pickAll").addEventListener("click", () => setHotelsExcluded(allIds(), false));
    $("pickNone").addEventListener("click", () => setHotelsExcluded(allIds(), true));

    $("calcBtn").addEventListener("click", calculate);
    $("printBtn").addEventListener("click", () => window.print());
    // 本社への報告は概要 1 枚で足りるため、名簿を省く印刷も用意する
    $("printOverviewBtn").addEventListener("click", () => {
      document.body.classList.add("overview-only");
      window.print();
    });
    window.addEventListener("afterprint", () => document.body.classList.remove("overview-only"));
    $("saveKeyBtn").addEventListener("click", testApiKey);
    $("rangeZone").addEventListener("change", refreshSelection);
    $("autoExpand").addEventListener("change", () => { if (lastResult) calculate(); });
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
