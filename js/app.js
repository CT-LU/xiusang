"use strict";
/**
 * エントリポイント：フォーム ↔ Allocator ↔ 結果表/地図/警示帯 の接続。
 * 「計算配分」はまずオフラインで即座に結果を出し、楽天照会は非同期で後追い更新する。
 */
(() => {
  const $ = id => document.getElementById(id);
  const LS_OVERRIDES = "narita.hotelOverrides.v1";
  const LS_PARTIES = "narita.parties.v1";

  const KIND_LABEL = {
    family: { ja: "家族", zh: "家庭" },
    group:  { ja: "団体", zh: "團體" },
    solo:   { ja: "個人", zh: "個人" }
  };

  let lastResult = null;
  let probeSeq = 0; // 古い非同期照会が新しい計算結果を上書きしないためのトークン
  let liveCharges = {}; // 楽天から取れた実勢価格 { hotelId: {min, max} }（日付依存のため永続化しない）

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
    return u.crew + u.accessible + u.partyPax + u.economy > 0;
  }

  // ---------- グループ登録（家族・団体・個人） ----------
  /**
   * 座席番号を展開する。搭乗券の記載をそのまま貼れるように複数の書き方を受ける。
   *   "32A"           → ["32A"]
   *   "32A-32C"       → 同じ列の連番
   *   "32A-34A"       → 同じ席番で列跨ぎ
   *   "32A,32B 33C"   → カンマ・読点・スラッシュ・空白いずれでも区切れる
   * 解釈できない書き方（"32A-34C" のように行も席も跨ぐ等）は null を返し、人数の自動補完をしない。
   * 座席表を持たないため実在確認はしない。あくまで名簿印字と人数の目安。
   */
  const SEAT_RE = /^(\d{1,3})([A-Za-z])$/;
  function expandSeats(str) {
    const raw = String(str || "").trim();
    if (!raw) return [];
    const out = [];
    for (const seg of raw.split(/[,、，\/\s]+/).filter(Boolean)) {
      const parts = seg.split(/[-–~〜]/);
      if (parts.length === 1) {
        const m = SEAT_RE.exec(parts[0]);
        if (!m) return null;
        out.push(`${parseInt(m[1], 10)}${m[2].toUpperCase()}`);
      } else if (parts.length === 2) {
        const a = SEAT_RE.exec(parts[0]), b = SEAT_RE.exec(parts[1]);
        if (!a || !b) return null;
        const r1 = parseInt(a[1], 10), r2 = parseInt(b[1], 10);
        const c1 = a[2].toUpperCase(), c2 = b[2].toUpperCase();
        if (r1 === r2 && c1 <= c2) {
          for (let c = c1.charCodeAt(0); c <= c2.charCodeAt(0); c++)
            out.push(`${r1}${String.fromCharCode(c)}`);
        } else if (c1 === c2 && r1 <= r2) {
          for (let r = r1; r <= r2; r++) out.push(`${r}${c1}`);
        } else return null;
      } else return null;
    }
    return out;
  }

  /** 座席番号パーサの自己検証（?selftest=1 で Allocator の自測と一緒に走る） */
  function runSeatSelfTests() {
    const f = [];
    const eq = (got, want, msg) => {
      if (JSON.stringify(got) !== JSON.stringify(want))
        f.push(`${msg}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
    };
    eq(expandSeats("32A-32C"), ["32A", "32B", "32C"], "S1 同列の範囲");
    eq(expandSeats("12A-14A"), ["12A", "13A", "14A"], "S2 列跨ぎの範囲");
    eq(expandSeats("32A, 33b 40C"), ["32A", "33B", "40C"], "S3 列挙（区切り・小文字混在）");
    eq(expandSeats("32A-32C,45D"), ["32A", "32B", "32C", "45D"], "S4 範囲と列挙の混在");
    eq(expandSeats(""), [], "S5 空欄");
    eq(expandSeats("32A-34C"), null, "S6 列も席も跨ぐ範囲は解釈しない");
    eq(expandSeats("32C-32A"), null, "S7 逆順は解釈しない");
    eq(expandSeats("あ"), null, "S8 不正文字");
    eq(expandSeats("32"), null, "S9 席番なし");
    return f;
  }

  /** 画面の登録グループ。auto=true の間は座席番号から人数を自動補完する（手入力したら止める） */
  let parties = [];

  function loadParties() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_PARTIES) || "[]");
      if (!Array.isArray(raw)) return [];
      return raw
        .filter(p => p && KIND_LABEL[p.kind])
        .map(p => ({
          kind: p.kind,
          size: Math.max(1, parseInt(p.size, 10) || 1),
          seats: String(p.seats || ""),
          auto: p.auto !== false
        }));
    } catch (e) { return []; }
  }
  function saveParties() {
    try { localStorage.setItem(LS_PARTIES, JSON.stringify(parties)); } catch (e) { /* ignore */ }
  }

  function newParty(kind, size, seats) {
    return { kind: kind || "family", size: Math.max(1, size | 0) || 1, seats: seats || "", auto: true };
  }

  /** 登録グループ由来の警示（座席重複・人数超過）。分配結果の validation に足して表示する */
  function partyWarnings(input) {
    const out = [];
    const seen = new Map();
    for (const p of parties) {
      for (const s of (expandSeats(p.seats) || [])) seen.set(s, (seen.get(s) || 0) + 1);
    }
    const dup = [...seen.entries()].filter(([, n]) => n > 1);
    if (dup.length) {
      out.push({ severity: "warn", code: "party-seat-dup",
        params: { seats: dup.slice(0, 6).map(([s]) => s).join(", ") + (dup.length > 6 ? " …" : ""),
                  n: dup[0][1] } });
    }
    const pax = parties.reduce((a, p) => a + p.size, 0);
    if (pax > input.totalPax) out.push({ severity: "warn", code: "party-over-total", params: { n: pax } });
    return out;
  }

  function renderParties() {
    const box = $("partyList");
    box.innerHTML = "";
    parties.forEach((p, i) => {
      const seats = expandSeats(p.seats);
      const row = document.createElement("div");
      row.className = "party-row" + (p.seats.trim() && seats === null ? " bad-seats" : "");
      row.dataset.i = i;
      row.innerHTML = `
        <select class="p-kind" title="家族=家庭（4名/室）/ 団体=團體（2名/室）/ 個人=個人（1名/室）">
          ${Object.keys(KIND_LABEL).map(k =>
            `<option value="${k}" ${k === p.kind ? "selected" : ""}>${KIND_LABEL[k].ja}</option>`).join("")}
        </select>
        <input type="number" class="p-size" min="1" value="${p.size}">
        <input type="text" class="p-seats" value="${p.seats.replace(/"/g, "&quot;")}" placeholder="32A-32C">
        <button type="button" class="p-del" title="この組を削除 / 刪除這組">✕</button>`;
      box.appendChild(row);
    });
    updatePartySummary();
  }

  /** 登録合計と「残り＝一般旅客」を出す。負なら入力矛盾なので赤字で示す */
  function updatePartySummary() {
    const n = (id) => Math.max(0, parseInt($(id).value, 10) || 0);
    const pax = parties.reduce((a, p) => a + p.size, 0);
    const rest = n("totalPax") - n("premiumPax") - n("wheelchairPax") - pax;
    const byKind = Object.keys(KIND_LABEL)
      .map(k => {
        const g = parties.filter(p => p.kind === k);
        return g.length ? `${KIND_LABEL[k].ja}${g.length}組${g.reduce((a, p) => a + p.size, 0)}名` : null;
      })
      .filter(Boolean).join("・");
    $("partySummary").innerHTML =
      `登録 <b>${parties.length}組 ${pax}名</b>${byKind ? `（${byKind}）` : ""}<br>` +
      `<span class="${rest < 0 ? "party-neg" : ""}">残り一般旅客 ${rest}名` +
      `<span class="ja">其餘經濟艙散客 ${rest}名${rest < 0 ? "（人數已超過總旅客數）" : ""}</span></span>`;
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

  /** API エラーを原因別の案内に振り分ける（キー違い / ドメイン未登録 / それ以外） */
  function apiErrorMsg(e) {
    const msg = (e && e.message) || "";
    if (e && e.kind === "origin") return I18N.t("api-origin-denied", { msg });
    if (e && e.kind === "auth") return I18N.t("api-auth-error", { msg });
    if (e && e.kind === "key") return I18N.t("api-key-invalid", { msg });
    return I18N.t("api-fail", { msg });
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
      setStatus("fail", apiErrorMsg(e));
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
      parties: parties.map(p => ({ kind: p.kind, size: p.size, seats: p.seats.trim() })),
      wheelchairPax: num("wheelchairPax", 0),
      crewCount: num("crewCount", 0),
      busCapacity: Math.max(1, num("busCapacity", 45)),
      busesAvailable: Math.max(1, num("busesAvailable", 6)),
      checkinDate: $("checkinDate").value || new Date().toISOString().slice(0, 10),
      occupancy: DEFAULTS.occupancy
    };
  }

  // ---------- 費用単価 ----------
  /**
   * 1室単価の決定：① 手動上書き → ② 楽天実勢 → ③ tier 既定値。
   * ② は「プラン最高値」を採る。最安値（hotelMinCharge）で見積もると本社報告が下振れするため、
   * 実際に押さえられる高位で保守的に置く。
   */
  function roomUnitFor(hotel, ov) {
    const o = ov[hotel.id];
    if (o && o.roomRate !== undefined && o.roomRate !== null && o.roomRate !== "")
      return { amount: Math.max(0, o.roomRate | 0), source: "manual" };
    const c = liveCharges[hotel.id];
    if (c && (c.max || c.min))
      return { amount: Math.max(c.max || 0, c.min || 0), source: "rakuten" };
    return { amount: COST_DEFAULTS.roomByTier[hotel.tier] || 0, source: "tier" };
  }

  const RATE_MARK = { manual: "✏手動", rakuten: "✓楽天", tier: "※推定" };

  function readRates(result) {
    const ov = loadOverrides();
    const roomUnit = {};
    for (const a of result.assignments) roomUnit[a.hotelId] = roomUnitFor(a.hotel, ov);
    const num = (id, def) => {
      const v = parseInt($(id).value, 10);
      return Number.isFinite(v) && v >= 0 ? v : def;
    };
    return {
      roomUnit,
      busPerTrip: num("busPerTrip", COST_DEFAULTS.busPerTrip),
      mealPerPax: num("mealPerPax", COST_DEFAULTS.mealPerPax),
      contingencyPct: num("contingencyPct", COST_DEFAULTS.contingencyPct)
    };
  }

  const yen = n => "¥" + Math.round(n || 0).toLocaleString("ja-JP");

  // ---------- 描画 ----------
  function bilingual(msg) {
    return `<span class="zh">${msg.zh}</span><span class="ja">${msg.ja}</span>`;
  }

  function renderValidation(result, extra) {
    const box = $("validation");
    box.innerHTML = "";
    // extraWarnings は入力そのものへの指摘（座席重複など）。楽天照会後の再描画でも消さない
    const items = [...result.validation, ...(result.extraWarnings || []), ...(extra || [])];
    const order = { error: 0, warn: 1, info: 2 };
    items.sort((a, b) => order[a.severity] - order[b.severity]);
    for (const v of items) {
      const div = document.createElement("div");
      div.className = `alert alert-${v.severity}`;
      div.innerHTML = bilingual(I18N.t(v.code, v.params));
      box.appendChild(div);
    }
  }

  /** 「3組/9名」＋ ツールチップに種別内訳（列幅が狭いので詳細はホバーへ逃がす） */
  function partyCell(asg) {
    const pt = asg.partyTotals;
    if (!pt.groups) return "0";
    const detail = Object.keys(KIND_LABEL)
      .filter(k => asg.breakdown[k].groups)
      .map(k => `${KIND_LABEL[k].ja}${asg.breakdown[k].groups}組${asg.breakdown[k].pax}名`)
      .join(" / ");
    const seats = asg.parties.filter(p => p.seats).map(p => p.seats).join(" ");
    return `<span title="${detail}${seats ? `｜座席 ${seats}` : ""}">${pt.groups}組/${pt.pax}名</span>`;
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

    const costByHotel = {};
    if (result.cost) for (const c of result.cost.room.byHotel) costByHotel[c.hotelId] = c;

    const mk = (asg, hotel, isExcluded) => {
      const h = hotel;
      const b = asg ? asg.breakdown : null;
      const vac = I18N.vacancyLabel(asg ? asg.vacancyTier : null);
      const cost = asg ? costByHotel[asg.hotelId] : null;
      const auto = roomUnitFor(h, ov);
      const manualRate = ov[h.id] && ov[h.id].roomRate !== undefined && ov[h.id].roomRate !== null
        ? ov[h.id].roomRate : "";
      const tr = document.createElement("tr");
      tr.className = (asg && asg.needsPhoneConfirm ? "needs-phone " : "") +
                     (isExcluded ? "excluded " : "") +
                     (asg && asg.totalPax === 0 ? "zero " : "");
      tr.innerHTML = `
        <td class="hotel-name">${h.nameJa}<br><small>${h.driveMinutes}分・tier${h.tier}・全${h.totalRooms}室${h.roomsVerified ? "✓" : "※"}${h.crewDesignated ? "・乗務員指定" : ""}</small></td>
        <td>${b ? b.crew.pax : "—"}</td>
        <td>${b ? b.premium.pax : "—"}</td>
        <td>${asg ? partyCell(asg) : "—"}</td>
        <td>${b ? b.accessible.pax : "—"}</td>
        <td>${b ? b.economy.pax : "—"}</td>
        <td class="total-cell">${asg ? `${asg.totalPax}名 / ${asg.totalRooms}室` : "—"}</td>
        <td class="cost-cell">${cost ? yen(cost.amount) : "—"}</td>
        <td class="vac-cell">${vac.zh}<br><small>${vac.ja}</small>${asg && asg.needsPhoneConfirm ? '<br><span class="warn-text">⚠ 要電話</span>' : ""}</td>
        <td>${asg && asg.busCount ? asg.busCount + "台" : "—"}</td>
        <td class="batches">${asg ? batchesText(asg) : ""}</td>
        <td><a href="tel:${h.phone}">${h.phone}</a><br><small>${h.phoneVerified ? "✓楽天" : "※要確認"}</small></td>
        <td><input type="number" class="ov-rooms" data-id="${h.id}" min="0" value="${(ov[h.id] && ov[h.id].usableRooms !== undefined) ? ov[h.id].usableRooms : h.usableRooms}"></td>
        <td><input type="number" class="ov-rate" data-id="${h.id}" min="0" step="1000" value="${manualRate}" placeholder="${auto.amount}"><br><small>${RATE_MARK[auto.source]}</small></td>
        <td><input type="checkbox" class="ov-exclude" data-id="${h.id}" ${isExcluded ? "checked" : ""}></td>`;
      return tr;
    };

    for (const asg of rows) tbody.appendChild(mk(asg, asg.hotel, false));
    for (const h of excluded) tbody.appendChild(mk(null, h, true));

    $("totCell").innerHTML =
      `${result.totals.pax}名 / ${result.totals.rooms}室 ・ 延べ${result.totals.trips}車次 ・ ` +
      `最終便帰着 T+${result.totals.lastReturnMin}分` +
      (result.cost ? ` ・ <b>概算費用 ${yen(result.cost.total)}</b>（1名 ${yen(result.cost.perPax)}）` : "");

    tbody.querySelectorAll(".ov-rooms").forEach(el => el.addEventListener("change", () => {
      const ov = loadOverrides();
      const id = el.dataset.id;
      ov[id] = ov[id] || {};
      ov[id].usableRooms = Math.max(0, parseInt(el.value, 10) || 0);
      saveOverrides(ov);
      calculate();
    }));
    // 空欄に戻すと自動単価（楽天実勢 → tier 既定値）に復帰する
    tbody.querySelectorAll(".ov-rate").forEach(el => el.addEventListener("change", () => {
      const ov = loadOverrides();
      const id = el.dataset.id;
      ov[id] = ov[id] || {};
      if (el.value === "") delete ov[id].roomRate;
      else ov[id].roomRate = Math.max(0, parseInt(el.value, 10) || 0);
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
   * 概要ページの配置図：外部タイルに依存しないインライン SVG。
   * 空港を原点として経緯度をメートル平面へ投影し、等比縮尺で描く（方位・相対距離は実測どおり）。
   * 番号はホテル別一覧の No. と一致。円の大きさは収容人数の目安。
   */
  function overviewMapSvg(rows) {
    if (!rows.length) return "";
    const W = 760, H = 300;
    // 右は「NRT 空港」ラベル、下は人数ラベル・目盛り・注記のための余白
    const PAD_L = 30, PAD_R = 95, PAD_T = 30, PAD_B = 46;
    const IW = W - PAD_L - PAD_R, IH = H - PAD_T - PAD_B;
    const MIN_SPAN_M = 8000; // 近郊に固まっている時に数kmの差を全画面へ誇張しない
    const c = AIRPORT_CENTER;
    const kx = 111320 * Math.cos(c.lat * Math.PI / 180);
    const pts = rows.map((a, i) => ({
      no: i + 1, asg: a,
      mx: (a.hotel.lng - c.lng) * kx,
      my: -(a.hotel.lat - c.lat) * 111320
    }));
    // 参照点が 1 つも枠に入らないと「どこの話か」が読めないので、ホテル群に近い 2 駅は
    // 縮尺の計算に必ず含める（空港近郊だけに配分した場合、成田駅すら枠外に落ちてしまうため）
    const lmAll = LANDMARKS.map(L => ({
      name: L.nameJa, mx: (L.lng - c.lng) * kx, my: -(L.lat - c.lat) * 111320
    }));
    const hx = pts.reduce((a, p) => a + p.mx, 0) / pts.length;
    const hy = pts.reduce((a, p) => a + p.my, 0) / pts.length;
    // 1 駅だけにする：2 駅入れると遠い方に引きずられて肝心のホテル群が隅に潰れる
    const anchors = [...lmAll]
      .sort((a, b) => Math.hypot(a.mx - hx, a.my - hy) - Math.hypot(b.mx - hx, b.my - hy))
      .slice(0, 1);

    const xs = [0, ...pts.map(p => p.mx), ...anchors.map(m => m.mx)];
    const ys = [0, ...pts.map(p => p.my), ...anchors.map(m => m.my)];
    const spanX = Math.max(Math.max(...xs) - Math.min(...xs), MIN_SPAN_M);
    const spanY = Math.max(Math.max(...ys) - Math.min(...ys), MIN_SPAN_M * IH / IW);
    const scale = Math.min(IW / spanX, IH / spanY);
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    const px = m => PAD_L + IW / 2 + (m - cx) * scale;
    const py = m => PAD_T + IH / 2 + (m - cy) * scale;
    const maxPax = Math.max(...rows.map(a => a.totalPax), 1);

    // 目盛り：図幅のおおよそ 1/5 に収まる切りの良い距離
    const niceKm = [1, 2, 5, 10, 20, 50].find(k => k * 1000 * scale > IW / 5) || 50;
    const barPx = niceKm * 1000 * scale;
    const ax = px(0), ay = py(0);
    // ターミナル同士は最短 1.1km。1km が 40px 未満だと重なって潰れるので単一表記に落とす
    const showTerminals = scale > 0.04;

    // 枠内に入るものだけ描く（上の anchors 2 駅は必ず入る。それ以外は縮尺次第）
    const marks = lmAll
      .map(L => ({ name: L.name, x: px(L.mx), y: py(L.my) }))
      // 下限は PAD_B より内側にすると、ホテルが描かれる最南端（PAD_T+IH）にある駅まで切れてしまう
      .filter(m => m.x > PAD_L - 6 && m.x < W - PAD_R + 30 && m.y > PAD_T - 6 && m.y < H - PAD_B + 4);

    return `
      <svg class="ov-map" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img">
        <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="none" stroke="#000" stroke-width="1"/>
        ${/* 駅の記号は最背面（主体はホテルなので、重なれば白地の円が上に来る）。
             駅名だけは最前面に白フチ付きで載せる（下記）ので、密集地でも読める */ ""}
        ${marks.map(m =>
          `<rect x="${m.x - 3.5}" y="${m.y - 3.5}" width="7" height="7" fill="#2a78d6"/>`).join("")}
        ${pts.map(p =>
          `<line x1="${ax}" y1="${ay}" x2="${px(p.mx)}" y2="${py(p.my)}"
                 stroke="#999" stroke-width="0.6" stroke-dasharray="3 3"/>`).join("")}
        ${(() => {
          // 軒数が多いと空港近郊で円が密集する。円を小さくし人数ラベルは省く
          // （番号は残るので一覧表で引ける。無理に載せるとラベルの列ができて図が読めなくなる）
          const dense = pts.length > 12;
          const nodes = pts.map(p => ({
            no: p.no, pax: p.asg.totalPax,
            x: px(p.mx), y: py(p.my),
            r: (dense ? 3.5 : 4.5) + (dense ? 5 : 9) * Math.sqrt(p.asg.totalPax / maxPax) // 面積で人数を表す
          }));
          if (dense) {
            return nodes.map(n =>
              `<circle cx="${n.x}" cy="${n.y}" r="${n.r}" fill="#fff" stroke="#000" stroke-width="1.1"/>
               <text x="${n.x}" y="${n.y + 2.6}" text-anchor="middle"
                     font-size="7" font-weight="bold">${n.no}</text>`).join("");
          }
          // 人数ラベルの簡易衝突回避：他のラベルにも他の円にも重ならない位置まで下げる
          const placed = [];
          for (const n of nodes) {
            n.ly = n.y + n.r + 8;
            for (let i = 0; i < 12; i++) {
              const hitLabel = placed.some(q => Math.abs(q.x - n.x) < 24 && Math.abs(q.y - n.ly) < 9);
              const hitCircle = nodes.some(m => m !== n && Math.hypot(m.x - n.x, m.y - n.ly) < m.r + 4);
              if (!hitLabel && !hitCircle) break;
              n.ly += 9;
            }
            placed.push({ x: n.x, y: n.ly });
          }
          // 引き出し線を先に全部描いてから円を重ねる（線が他の円を横切っても隠れる）
          return nodes.filter(n => n.ly > n.y + n.r + 12).map(n =>
            `<line x1="${n.x}" y1="${n.y + n.r}" x2="${n.x}" y2="${n.ly - 7}"
                   stroke="#666" stroke-width="0.5"/>`).join("") +
            nodes.map(n =>
            `<circle cx="${n.x}" cy="${n.y}" r="${n.r}" fill="#fff" stroke="#000" stroke-width="1.4"/>
             <text x="${n.x}" y="${n.y + 3.4}" text-anchor="middle"
                   font-size="9.5" font-weight="bold">${n.no}</text>
             <text x="${n.x}" y="${n.ly}" text-anchor="middle" font-size="7.5"
                   >${n.ly > n.y + n.r + 12 ? `${n.no}:` : ""}${n.pax}名</text>`).join("");
        })()}
        ${marks.map(m =>
          `<text x="${m.x + 6}" y="${m.y + 3}" font-size="8" fill="#333"
                 stroke="#fff" stroke-width="2.5" paint-order="stroke">${m.name}</text>`).join("")}
        ${showTerminals ? (() => {
          // バスの実際の発車地点。T+分の起点でもあるので、読める縮尺なら 3 つとも出す
          const ts = TERMINALS.map(t => ({
            id: t.id, x: px((t.lng - c.lng) * kx), y: py(-(t.lat - c.lat) * 111320)
          }));
          const top = Math.min(...ts.map(t => t.y));
          return ts.map(t =>
            `<path d="M ${t.x} ${t.y - 6} L ${t.x + 5.5} ${t.y + 4} L ${t.x - 5.5} ${t.y + 4} Z" fill="#000"/>
             <text x="${t.x + 8}" y="${t.y + 4}" font-size="8.5" font-weight="bold">${t.id}</text>`).join("") +
            `<text x="${ax + 10}" y="${top - 10}" font-size="9.5" font-weight="bold">NRT 空港</text>`;
        })() : `
        <path d="M ${ax - 11} ${ay} L ${ax + 11} ${ay} M ${ax} ${ay - 11} L ${ax} ${ay + 11}"
              stroke="#000" stroke-width="2.5"/>
        <text x="${ax + 14}" y="${ay + 4}" font-size="11" font-weight="bold">NRT 空港</text>`}
        <g transform="translate(${W - PAD_R - barPx}, ${H - 14})">
          <rect x="-6" y="-16" width="${barPx + 12}" height="22" fill="#fff"/>
          <line x1="0" y1="0" x2="${barPx}" y2="0" stroke="#000" stroke-width="1.6"/>
          <line x1="0" y1="-4" x2="0" y2="4" stroke="#000" stroke-width="1.6"/>
          <line x1="${barPx}" y1="-4" x2="${barPx}" y2="4" stroke="#000" stroke-width="1.6"/>
          <text x="${barPx / 2}" y="-6" text-anchor="middle" font-size="9">${niceKm} km</text>
        </g>
        <g transform="translate(${PAD_L - 12}, ${PAD_T - 16})">
          <path d="M 0 14 L 0 0 M 0 0 L -4 5 M 0 0 L 4 5" stroke="#000" stroke-width="1.4" fill="none"/>
          <text x="6" y="8" font-size="9">N</text>
        </g>
        ${/* 凡例：白黒印刷では色が落ちるため、形（白抜きの円／塗りの四角）で区別できるようにしてある。
             ホテルが重なっても読めるよう白地を敷く */ ""}
        <g transform="translate(${PAD_L - 12}, ${H - 26})">
          <rect x="-4" y="-11" width="${(marks.length ? 268 : 215) + (showTerminals ? 92 : 0)}" height="16" fill="#fff"/>
          <circle cx="6" cy="-3" r="6" fill="#fff" stroke="#000" stroke-width="1.4"/>
          <text x="17" y="0" font-size="8">割当ホテル（数字＝No.・円の大きさ＝人数）</text>
          ${marks.length ? `<rect x="215" y="-6.5" width="7" height="7" fill="#2a78d6"/>
          <text x="227" y="0" font-size="8">主要駅</text>` : ""}
          ${showTerminals ? `<path d="M 274 -8 L 279 0 L 269 0 Z" fill="#000"/>
          <text x="284" y="0" font-size="8">ターミナル（発車地点）</text>` : ""}
        </g>
        <g transform="translate(${PAD_L - 12}, ${H - 10})">
          <rect x="-4" y="-9" width="264" height="13" fill="#fff"/>
          <text x="0" y="0" font-size="8.5" fill="#333">
            ※ 空港の西約60km に東京都心 / 東京市中心在機場西方約60km
          </text>
        </g>
      </svg>`;
  }

  /**
   * 印刷 1 枚目：本社報告用サマリ。
   * 「何名をどこへ・バス何台・いつ終わる・何が未解決か」を 1 ページに集約する。
   * 便名と配車開始時刻 T の実時刻は入力項目に無いため手書き欄とする。
   */
  function overviewSheet(result) {
    const input = result.input, zone = result.usedZone;
    const rows = [...result.assignments]
      .filter(a => a.totalPax > 0)
      .sort((a, b) => a.hotel.driveMinutes - b.hotel.driveMinutes || b.totalPax - a.totalPax);
    const risks = result.validation.filter(v => v.severity !== "info");
    const u = result.unassigned;
    const unplaced = u.crew + u.accessible + u.partyPax + u.economy;
    const allParties = result.parties || [];
    const partyPax = allParties.reduce((a, p) => a + p.size, 0);
    const partyByKind = Object.keys(KIND_LABEL)
      .map(k => {
        const g = allParties.filter(p => p.kind === k);
        return g.length ? `${KIND_LABEL[k].ja}${g.length}組${g.reduce((a, p) => a + p.size, 0)}名` : null;
      })
      .filter(Boolean).join(" / ") || "登録なし";
    const orphans = allParties.filter(p => !p.hotelId);
    const sum = pool => rows.reduce((a, r) => a + r.breakdown[pool].pax, 0);
    const sumParties = () => rows.reduce((a, r) => a + r.partyTotals.pax, 0);
    const sumPartyGroups = () => rows.reduce((a, r) => a + r.partyTotals.groups, 0);
    const cost = result.cost;
    const costByHotel = {};
    if (cost) for (const c of cost.room.byHotel) costByHotel[c.hotelId] = c;

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
          <th>グループ / 分組</th><td>${allParties.length}組 ${partyPax}名<br><small>${partyByKind}</small></td>
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

      ${orphans.length ? `
      <h3>未手配グループ（個別対応）<span class="ja">未安置的組別｜需人工安排</span></h3>
      <table class="ov-table">
        <thead><tr><th>No.</th><th>種別</th><th>人数</th><th class="l">座席番号</th><th>必要室数</th><th class="l">対応記録 / 處理記錄</th></tr></thead>
        <tbody>
          ${orphans.map(p => `<tr>
            <td>${p.no}</td><td>${KIND_LABEL[p.kind].ja}</td><td>${p.size}名</td>
            <td class="l">${p.seats || "—"}</td><td>${p.rooms}室</td><td class="l"></td>
          </tr>`).join("")}
        </tbody>
      </table>` : ""}

      ${cost ? `
      <h3>概算費用 <span class="ja">費用預估（円・税サービス料込）</span></h3>
      <table class="ov-cost">
        <thead>
          <tr>
            <th>宿泊 ${result.totals.rooms}室</th>
            <th>バス ${cost.bus.trips}車次<br><small>@${cost.bus.unit.toLocaleString("ja-JP")}</small></th>
            <th>食事 ${cost.meal.pax}名<br><small>@${cost.meal.unit.toLocaleString("ja-JP")}</small></th>
            <th>小計</th>
            <th>雑費・予備費 ${cost.contingency.pct}%</th>
            <th class="grand">合計</th>
            <th>1名あたり</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>${yen(cost.room.amount)}</td>
            <td>${yen(cost.bus.amount)}</td>
            <td>${yen(cost.meal.amount)}</td>
            <td>${yen(cost.subtotal)}</td>
            <td>${yen(cost.contingency.amount)}</td>
            <td class="grand">${yen(cost.total)}</td>
            <td>${yen(cost.perPax)}</td>
          </tr>
        </tbody>
      </table>
      <p class="ov-note">
        ※ 宿泊単価の出所：楽天実勢 ${cost.sources.rakuten || 0}軒 ／ 手動 ${cost.sources.manual || 0}軒 ／ 推定 ${cost.sources.tier || 0}軒。
        実勢価格は一般販売の税サ込単価を保守側（予約可能プランの高位）で採用しており、航空会社の契約単価は通常これを下回ります。
        オンライン照会は1室1名利用の価格のため、2名/室で埋める一般旅客分は上振れする可能性があります。バス・食事は手動単価です。
        <span class="zh">※ 住宿單價來源：楽天實勢 ${cost.sources.rakuten || 0} 家／手動 ${cost.sources.manual || 0} 家／推定 ${cost.sources.tier || 0} 家。實勢價取一般散客牌價的高位（保守），航空公司契約價通常低於此；線上查詢為 1 室 1 人的價格，2 人／房的實際金額可能高於預估。巴士與餐費為手動單價。</span>
      </p>` : ""}

      <h3>配置図（空港からの方位・距離）<span class="ja">飯店與機場的相對位置｜圓內編號對應下表 No.，圓大小＝收容人數</span></h3>
      ${overviewMapSvg(rows)}

      <h3>ホテル別 配分一覧 <span class="ja">各飯店分配明細</span></h3>
      <table class="ov-table${rows.length > 9 ? " dense" : ""}">
        <thead>
          <tr>
            <th>No.</th><th class="l">ホテル / 飯店</th><th>車程</th><th>乗務員</th><th>C・F</th>
            <th>グループ</th><th>車椅子</th><th>一般</th><th>計（名/室）</th>
            <th>宿泊費</th><th>バス</th><th>発車 T+分</th><th class="l">TEL</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((a, i) => {
            const b = a.breakdown;
            return `<tr>
              <td class="strong">${i + 1}</td>
              <td class="l">${a.hotel.nameJa}${a.hotel.crewDesignated ? " <small>（乗務員指定）</small>" : ""}</td>
              <td>${a.hotel.driveMinutes}分</td>
              <td>${b.crew.pax || ""}</td>
              <td>${b.premium.pax || ""}</td>
              <td>${a.partyTotals.groups ? `${a.partyTotals.groups}組${a.partyTotals.pax}名` : ""}</td>
              <td>${b.accessible.pax || ""}</td>
              <td>${b.economy.pax || ""}</td>
              <td class="strong">${a.totalPax} / ${a.totalRooms}</td>
              <td class="money">${costByHotel[a.hotelId]
                ? `${yen(costByHotel[a.hotelId].amount)}<br><small>@${(costByHotel[a.hotelId].unit).toLocaleString("ja-JP")}${RATE_MARK[costByHotel[a.hotelId].source].slice(0, 1)}</small>`
                : "—"}</td>
              <td>${a.busCount || ""}</td>
              <td>${departSpan(a)}</td>
              <td class="l tel">${a.hotel.phone}</td>
            </tr>`;
          }).join("")}
        </tbody>
        <tfoot>
          <tr>
            <th></th><th class="l">合計 / 總計</th><th></th>
            <th>${sum("crew")}</th><th>${sum("premium")}</th>
            <th>${sumPartyGroups()}組${sumParties()}名</th>
            <th>${sum("accessible")}</th><th>${sum("economy")}</th>
            <th class="strong">${result.totals.pax} / ${result.totals.rooms}</th>
            <th class="money">${cost ? yen(cost.room.amount) : "—"}</th>
            <th>${result.totals.trips}車次</th><th>T+${result.totals.lastReturnMin}帰着</th><th></th>
          </tr>
        </tfoot>
      </table>

      <p class="ov-note">
        ※「T+分」は配車開始時刻 T からの経過分。室数・空室は電話確認前の計画値です。
        <span class="zh">※「T+分」為發車起點 T 起算的分鐘數；房數與空房為電話確認前的計劃值。</span>
      </p>`;
    return div;
  }

  /** 印刷用：1 枚目に本社報告用サマリ、以降はホテルごと 1 ページの乗車名簿ヘッダ */
  function renderPrintSheets(result) {
    const box = $("printSheets");
    box.innerHTML = "";
    box.appendChild(overviewSheet(result));
    for (const asg of result.assignments) {
      if (asg.totalPax === 0) continue;
      const div = document.createElement("div");
      div.className = "print-sheet";
      div.innerHTML = `
        <h2>${asg.hotel.nameJa}</h2>
        <p>分配 ${asg.totalPax}名 / ${asg.totalRooms}室 ・ バス${asg.busCount}台 ・ 車程${asg.hotel.driveMinutes}分 ・ TEL ${asg.hotel.phone}</p>
        <p>内訳：乗務員${asg.breakdown.crew.pax} / C・F ${asg.breakdown.premium.pax} / グループ${asg.partyTotals.groups}組${asg.partyTotals.pax}名 / 車椅子${asg.breakdown.accessible.pax} / 一般${asg.breakdown.economy.pax}</p>
        ${asg.parties.length ? `
        <h3 class="print-sub">グループ内訳（同一組は分割しない）<span class="ja">分組明細｜同組不拆散</span></h3>
        <table class="print-parties">
          <tr><th>No.</th><th>種別</th><th>人数</th><th>座席番号</th><th>室数</th><th>部屋番号</th><th>確認</th></tr>
          ${asg.parties.map(p =>
            `<tr><td>${p.no}</td><td>${KIND_LABEL[p.kind].ja}</td><td>${p.size}名</td>
              <td class="seats">${p.seats || ""}</td><td>${p.rooms}室</td><td></td><td></td></tr>`).join("")}
        </table>` : ""}
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
      const { tiers, charges } = await RakutenAPI.probeVacancy(hotels, checkinDate);
      if (seq !== probeSeq) return; // 既に再計算済み
      liveCharges = charges;
      // 実勢価格が入ったので費用を引き直す（手動単価が入っているホテルはそのまま）
      result.cost = Allocator.estimateCost(result, readRates(result));
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
      renderPrintSheets(result);
      MapView.update(mapItems(result, result.usedZone || 3));
      const priced = Object.keys(charges).length;
      renderValidation(result, [
        { severity: "info", code: "api-probe-done", params: { n: withData } },
        { severity: "info", code: "vacancy-note", params: {} },
        ...(priced ? [{ severity: "info", code: "rate-live", params: { n: priced } }] : [])
      ]);
    } catch (e) {
      if (seq !== probeSeq) return;
      setStatus("fail", apiErrorMsg(e));
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
    lastResult.input = input; // 印刷の概要ページと楽天照会後の再描画で再利用する
    lastResult.extraWarnings = partyWarnings(input);
    lastResult.cost = Allocator.estimateCost(lastResult, readRates(lastResult));
    renderValidation(lastResult);
    renderTable(lastResult);
    renderPrintSheets(lastResult);
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
      wheelchairPax: DEFAULTS.wheelchairPax, crewCount: DEFAULTS.crewCount,
      busCapacity: DEFAULTS.busCapacity, busesAvailable: DEFAULTS.busesAvailable,
      busPerTrip: COST_DEFAULTS.busPerTrip, mealPerPax: COST_DEFAULTS.mealPerPax,
      contingencyPct: COST_DEFAULTS.contingencyPct,
      quickCount: DEFAULTS.familyGroups, quickSize: DEFAULTS.familyAvgSize
    })) $(id).value = val;
    $("checkinDate").value = new Date().toISOString().slice(0, 10);
    $("appId").value = RakutenAPI.getAppId();
    $("accessKey").value = RakutenAPI.getAccessKey();
    // URL パラメータで上書き（シナリオのブックマークやテストに使用）
    const q = new URLSearchParams(location.search);
    for (const id of ["totalPax", "premiumPax",
                      "wheelchairPax", "crewCount", "busCapacity", "busesAvailable", "rangeZone",
                      "busPerTrip", "mealPerPax", "contingencyPct"]) {
      if (q.has(id)) $(id).value = q.get(id);
    }
    if (q.has("autoExpand")) $("autoExpand").checked = q.get("autoExpand") !== "0";

    // グループは前回の登録を復元する。未保存（初回）と URL 指定時だけ一括生成で埋める。
    // 「全消去」した状態も保存済みなので、空のまま復元されて勝手に湧き戻らない。
    parties = loadParties();
    const seeded = q.has("familyGroups") || q.has("familyAvgSize");
    if (seeded || localStorage.getItem(LS_PARTIES) === null) {
      const n = q.has("familyGroups") ? Math.max(0, parseInt(q.get("familyGroups"), 10) || 0) : DEFAULTS.familyGroups;
      const sz = q.has("familyAvgSize") ? Math.max(1, parseInt(q.get("familyAvgSize"), 10) || 1) : DEFAULTS.familyAvgSize;
      parties = Array.from({ length: n }, () => newParty("family", sz, ""));
      if (!seeded) saveParties(); // URL シナリオは一時的なものなので保存しない
    }
    renderParties();
    renderPicker(parseInt($("rangeZone").value, 10) || 1);
  }

  /** グループ登録の操作（追加・削除・一括生成）を配線する */
  function initPartyUI() {
    const recalc = () => { if (lastResult) calculate(); };
    const box = $("partyList");

    box.addEventListener("input", e => {
      const row = e.target.closest(".party-row");
      if (!row) return;
      const p = parties[+row.dataset.i];
      if (!p) return;
      if (e.target.classList.contains("p-size")) {
        p.size = Math.max(1, parseInt(e.target.value, 10) || 1);
        p.auto = false; // 手入力を尊重（幼児など座席の無い同行者がいるケース）
      } else if (e.target.classList.contains("p-seats")) {
        p.seats = e.target.value;
        const seats = expandSeats(p.seats);
        row.classList.toggle("bad-seats", p.seats.trim() !== "" && seats === null);
        if (p.auto && seats && seats.length) {
          p.size = seats.length;
          row.querySelector(".p-size").value = seats.length;
        }
      }
      saveParties();
      updatePartySummary();
    });
    box.addEventListener("change", e => {
      const row = e.target.closest(".party-row");
      if (!row) return;
      const p = parties[+row.dataset.i];
      if (p && e.target.classList.contains("p-kind")) { p.kind = e.target.value; saveParties(); }
      recalc(); // 種別で1室あたり人数が変わるため、確定した時点で引き直す
    });
    box.addEventListener("click", e => {
      if (!e.target.classList.contains("p-del")) return;
      parties.splice(+e.target.closest(".party-row").dataset.i, 1);
      saveParties();
      renderParties();
      recalc();
    });

    $("addParty").addEventListener("click", () => {
      parties.push(newParty($("quickKind").value, 1, ""));
      saveParties();
      renderParties();
      // 追加直後は座席番号を打つのが自然な流れなので、そこへ焦点を移す
      const last = $("partyList").lastElementChild;
      if (last) last.querySelector(".p-seats").focus();
      recalc();
    });
    $("clearParties").addEventListener("click", () => {
      if (parties.length && !confirm("登録グループをすべて削除します / 將刪除所有已登記的組別")) return;
      parties = [];
      saveParties();
      renderParties();
      recalc();
    });
    $("quickAdd").addEventListener("click", () => {
      const n = Math.max(0, parseInt($("quickCount").value, 10) || 0);
      const sz = Math.max(1, parseInt($("quickSize").value, 10) || 1);
      for (let i = 0; i < n; i++) parties.push(newParty($("quickKind").value, sz, ""));
      saveParties();
      renderParties();
      recalc();
    });
    for (const id of ["totalPax", "premiumPax", "wheelchairPax"]) {
      $(id).addEventListener("input", updatePartySummary);
    }
  }

  async function testApiKey() {
    RakutenAPI.setAppId($("appId").value);
    RakutenAPI.setAccessKey($("accessKey").value);
    if (!RakutenAPI.getAppId()) { setStatus("offline", I18N.t("api-no-key")); return; }
    setStatus("probing", I18N.t("api-probing"));
    try {
      const ok = await RakutenAPI.testKey();
      // 旧方式のまま通った場合は、新規キーなら accessKey が要る旨を添える
      setStatus(ok ? "ok" : "fail",
        ok ? (RakutenAPI.isV2() ? I18N.t("api-ok") : I18N.t("api-legacy-mode"))
           : I18N.t("api-fail", { msg: "no data" }));
      // key 有効かつ未同期なら、電話・総室数を自動で公式データに更新
      if (ok && Object.keys(RakutenAPI.getFacts()).length === 0) await syncFacts();
    } catch (e) {
      setStatus("fail", apiErrorMsg(e));
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    applyFacts();
    initForm();
    initPartyUI();
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
    // 未計算のまま印刷すると真っ白な紙が出てしまうので、その場で計算してから出す
    const ensureSheets = () => { if (!lastResult) calculate(); };

    // 紙面は画面上では非表示のため、印刷せずに確認する手段を用意する
    $("previewBtn").addEventListener("click", () => {
      ensureSheets();
      const on = !document.body.classList.contains("preview-sheets");
      document.body.classList.toggle("preview-sheets", on);
      document.body.classList.remove("overview-only"); // プレビューは全ページ表示
      $("previewBtn").classList.toggle("active", on);
      $("previewBtn").innerHTML = on
        ? 'プレビューを閉じる<span class="ja">關閉預覽</span>'
        : '紙面をプレビュー<span class="ja">在畫面上預覽列印內容</span>';
      if (on) $("printSheets").scrollIntoView({ behavior: "smooth", block: "start" });
    });

    $("printBtn").addEventListener("click", () => { ensureSheets(); window.print(); });
    // 本社への報告は概要 1 枚で足りるため、名簿を省く印刷も用意する
    $("printOverviewBtn").addEventListener("click", () => {
      ensureSheets();
      document.body.classList.add("overview-only");
      window.print();
    });
    window.addEventListener("afterprint", () => document.body.classList.remove("overview-only"));
    $("saveKeyBtn").addEventListener("click", testApiKey);
    $("rangeZone").addEventListener("change", refreshSelection);
    $("autoExpand").addEventListener("change", () => { if (lastResult) calculate(); });
    // 単価を触ったら即座に費用を引き直す（分配自体は変わらないが再計算で十分速い）
    for (const id of ["busPerTrip", "mealPerPax", "contingencyPct"]) {
      $(id).addEventListener("change", () => { if (lastResult) calculate(); });
    }
    $("inputForm").addEventListener("submit", e => { e.preventDefault(); calculate(); });

    // ?preview=1 で紙面プレビューを開いた状態にする（動作確認・共有用）
    if (new URLSearchParams(location.search).get("preview") === "1") $("previewBtn").click();

    if (new URLSearchParams(location.search).get("selftest") === "1") {
      calculate(); // selftest 時はデフォルト値で E2E スモークも実行
      const r = Allocator.runSelfTests();
      const failures = [...r.failures, ...runSeatSelfTests()];
      const div = document.createElement("div");
      div.className = `alert ${failures.length ? "alert-error" : "alert-info"}`;
      div.textContent = `[selftest] ${failures.length ? "FAILED: " + failures.join(" | ") : "ALL PASS"}`;
      $("validation").appendChild(div);
    }
  });
})();
