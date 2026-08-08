"use strict";
/**
 * 楽天トラベルAPI クライアント
 * - 節流：リクエスト間隔 1.1 秒、429 は指数バックオフで 2 回まで再試行
 * - CORS 実測済み（新旧とも Access-Control-Allow-Origin: *、プリフライトも 200）
 * - VacantHotelSearch は空室「数」を返さないため roomNum=10→5→1 の探測で階層化する
 * - hotelNo はカンマ区切りで一括最大 15 軒。初回に SimpleHotelSearch(geo) で自動解決し localStorage にキャッシュ
 *
 * 2026 年のインフラ刷新で認証が二段になった：
 *   新体系 openapi.rakuten.co.jp … applicationId + accessKey が必須。
 *          アプリ種別「Webアプリケーション」で登録し、許可サイト（Origin/Referer）で検証される。
 *          → file:// で直接開くと Referer が付かず弾かれる可能性が高い（配分機能はオフラインで動く）。
 *   旧体系 app.rakuten.co.jp … applicationId のみ。既存 key の退路として残す。
 * accessKey が入力されていれば新体系、無ければ旧体系へ。エラー形式も両者で異なるため normalizeError で吸収する。
 */
const RakutenAPI = (() => {
  const HOSTS = {
    v2: "https://openapi.rakuten.co.jp/engine/api/Travel",
    v1: "https://app.rakuten.co.jp/services/api/Travel"
  };
  const PATHS = {
    vacant: "VacantHotelSearch/20170426",
    simple: "SimpleHotelSearch/20170426",
    detail: "HotelDetailSearch/20170426"
  };
  const LS_APP_ID = "narita.rakutenAppId";
  const LS_ACCESS_KEY = "narita.rakutenAccessKey";
  const LS_HOTEL_NOS = "narita.rakutenHotelNos.v1";
  const LS_FACTS = "narita.hotelFacts.v1";
  const GAP_MS = 1100;
  const TIMEOUT_MS = 10000;

  let lastRequestAt = 0;
  let queue = Promise.resolve();
  let jsonpCounter = 0;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const lsGet = k => { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, String(v || "").trim()); } catch (e) { /* private mode */ } };

  function getAppId() { return lsGet(LS_APP_ID); }
  function setAppId(id) { lsSet(LS_APP_ID, id); }
  function getAccessKey() { return lsGet(LS_ACCESS_KEY); }
  function setAccessKey(k) { lsSet(LS_ACCESS_KEY, k); }

  /** accessKey の有無で新旧どちらの体系を使うか決まる */
  function isV2() { return !!getAccessKey(); }
  function endpointOf(name) { return `${isV2() ? HOSTS.v2 : HOSTS.v1}/${PATHS[name]}`; }

  function buildUrl(endpoint, params) {
    const base = { applicationId: getAppId(), format: "json", formatVersion: "2" };
    if (isV2()) base.accessKey = getAccessKey();
    return `${endpoint}?${new URLSearchParams(Object.assign(base, params)).toString()}`;
  }

  /**
   * 新旧でエラー形式が違うのを 1 つに揃える。
   *   新: { errors: { errorCode: 403, errorMessage: "Invalid Access Key" } }
   *   旧: { error: "wrong_parameter", error_description: "specify valid applicationId" }
   * @returns {null|{code:number, msg:string, kind:"not_found"|"key"|"origin"|"other"}}
   */
  function normalizeError(body, status) {
    let code = 0, msg = "";
    if (body && body.errors && (body.errors.errorCode || body.errors.errorMessage)) {
      code = parseInt(body.errors.errorCode, 10) || status || 0;
      msg = String(body.errors.errorMessage || "");
    } else if (body && body.error) {
      code = status || 0;
      msg = `${body.error}: ${body.error_description || ""}`;
      if (body.error === "not_found") return { code: 404, msg, kind: "not_found" };
    } else {
      return null;
    }
    if (code === 404 || /not[\s_]?found/i.test(msg)) return { code, msg, kind: "not_found" };
    // 許可サイト／IP の登録漏れ。key 自体は正しいので案内を分ける
    if (/not[\s_]?allowed|referer|referrer|origin|forbidden.*(site|domain)/i.test(msg))
      return { code, msg, kind: "origin" };
    // 「Authentication service error」(503) は実測で無効キーでも楽天側の一時障害でも返る。
    // どちらか断定できないので、キー誤りと断じずに再試行を促す分類にする。
    if (code === 503 || /authentication service/i.test(msg))
      return { code, msg, kind: "auth" };
    if (/applicationId|application_id|access\s?key|unauthorized|invalid/i.test(msg) || code === 401 || code === 403)
      return { code, msg, kind: "key" };
    return { code, msg, kind: "other" };
  }

  function jsonpFetch(url) {
    return new Promise((resolve, reject) => {
      const cbName = `__rakutenCb_${++jsonpCounter}`;
      const script = document.createElement("script");
      const cleanup = () => { delete window[cbName]; script.remove(); clearTimeout(timer); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("JSONP timeout")); }, 30000);
      window[cbName] = data => { cleanup(); resolve(data); };
      script.onerror = () => { cleanup(); reject(new Error("JSONP load error")); };
      script.src = `${url}&callback=${cbName}`;
      document.head.appendChild(script);
    });
  }

  /**
   * 節流付きリクエスト。「該当なし」(404 not_found) は {notFound:true} を返す（エラー扱いしない）。
   * @param {string} name PATHS のキー
   */
  function request(name, params) {
    const run = async () => {
      const url = buildUrl(endpointOf(name), params);
      for (let attempt = 0; ; attempt++) {
        const wait = lastRequestAt + GAP_MS - Date.now();
        if (wait > 0) await sleep(wait);
        lastRequestAt = Date.now();
        let res, body;
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
          res = await fetch(url, { signal: ctrl.signal });
          clearTimeout(timer);
          body = await res.json();
        } catch (e) {
          // 新体系は callback を無視して素の JSON を返すため JSONP が成立しない（実測）。
          // 旧体系のみフォールバックし、新体系はネットワーク errors をそのまま上げる。
          if (isV2()) throw e;
          body = await jsonpFetch(url);
          res = null;
        }
        const err = normalizeError(body, res ? res.status : 0);
        if (err && err.kind === "not_found") return { notFound: true };
        if (res && res.status === 429 && attempt < 2) { await sleep(2000 * Math.pow(2, attempt)); continue; }
        if (err) {
          const e = new Error(err.msg || `HTTP ${err.code}`);
          // 施設同期は 1 軒ずつ回るため、認証系は 1 軒目で中断する（全軒失敗を待たない）
          e.isKeyError = err.kind === "key" || err.kind === "origin" || err.kind === "auth";
          e.kind = err.kind;
          throw e;
        }
        if (res && !res.ok) throw new Error(`HTTP ${res.status}`);
        return body;
      }
    };
    // 直列キュー（並行呼び出しでも 1.1s 間隔を保証）
    const p = queue.then(run);
    queue = p.catch(() => {});
    return p;
  }

  /** formatVersion=2 の hotels 配列から hotelBasicInfo を平坦化 */
  function extractBasicInfos(body) {
    const out = [];
    for (const hotel of body.hotels || []) {
      const parts = Array.isArray(hotel) ? hotel : hotel.hotel || [];
      for (const part of parts) {
        if (part && part.hotelBasicInfo) out.push(part.hotelBasicInfo);
      }
    }
    return out;
  }

  /** applicationId の有効性確認（空港エリアで 1 軒だけ検索） */
  async function testKey() {
    const body = await request("simple", {
      latitude: GEO_SEARCH_CENTERS[0].lat, longitude: GEO_SEARCH_CENTERS[0].lng,
      searchRadius: 3, datumType: 1, hits: 1
    });
    return !body.notFound && extractBasicInfos(body).length > 0;
  }

  const norm = s => String(s || "").replace(/[\s　]/g, "").toLowerCase();
  function distMeters(aLat, aLng, bLat, bLng) {
    const dLat = (aLat - bLat) * 111320;
    const dLng = (aLng - bLng) * 111320 * Math.cos(aLat * Math.PI / 180);
    return Math.hypot(dLat, dLng);
  }

  /**
   * 静的リストの rakutenHotelNo を SimpleHotelSearch(geo×2円心) で解決。
   * 座標 400m 以内 or 名称一致でマッチ。結果は localStorage にキャッシュ。
   */
  async function resolveHotelNos(hotels) {
    let cache = {};
    try { cache = JSON.parse(localStorage.getItem(LS_HOTEL_NOS) || "{}"); } catch (e) { /* ignore */ }
    const unresolved = hotels.filter(h => !h.rakutenHotelNo && !cache[h.id]);
    if (unresolved.length > 0) {
      const candidates = [];
      for (const c of GEO_SEARCH_CENTERS) {
        const body = await request("simple", {
          latitude: c.lat, longitude: c.lng, searchRadius: 3, datumType: 1, hits: 30
        });
        if (!body.notFound) candidates.push(...extractBasicInfos(body));
      }
      for (const h of unresolved) {
        const hit = candidates.find(cand =>
          distMeters(h.lat, h.lng, cand.latitude, cand.longitude) < 400 &&
          (norm(cand.hotelName).includes(norm(h.nameJa).slice(0, 6)) ||
           norm(h.nameJa).includes(norm(cand.hotelName).slice(0, 6)))
        ) || candidates.find(cand => norm(cand.hotelName) === norm(h.nameJa));
        if (hit) cache[h.id] = hit.hotelNo;
      }
      try { localStorage.setItem(LS_HOTEL_NOS, JSON.stringify(cache)); } catch (e) { /* ignore */ }
    }
    for (const h of hotels) {
      if (!h.rakutenHotelNo && cache[h.id]) h.rakutenHotelNo = cache[h.id];
    }
    return hotels.filter(h => h.rakutenHotelNo).length;
  }

  /**
   * VacantHotelSearch のレスポンスから 1室1泊あたりの価格帯を抽出（追加リクエスト不要）。
   * min = hotelMinCharge（「1部屋1泊あたり、税・サービス料込みの最安値の目安」）
   * max = 各プラン dailyCharge の最大値（＝実際に取れる高位。予算は保守側で見る）
   *
   * ※ chargeFlag=0 は「1名あたり」の額。照会は adultNum=1 のため 1室1名利用の価格であり、
   *   2名/室で埋める一般旅客の実額はこれを上回る（費用予測が下振れする方向の既知バイアス）。
   */
  function extractCharges(body) {
    const out = {};
    for (const hotel of body.hotels || []) {
      const parts = Array.isArray(hotel) ? hotel : hotel.hotel || [];
      let no = null, min = null, max = null;
      for (const part of parts) {
        if (!part || typeof part !== "object") continue;
        if (part.hotelBasicInfo) {
          no = String(part.hotelBasicInfo.hotelNo);
          const c = parseInt(part.hotelBasicInfo.hotelMinCharge, 10);
          if (Number.isFinite(c) && c > 0) min = c;
        }
        for (const room of part.roomInfo || []) {
          const dc = room && room.dailyCharge;
          if (!dc) continue;
          const v = parseInt(dc.total !== undefined ? dc.total : dc.rakutenCharge, 10);
          if (Number.isFinite(v) && v > 0) max = max === null ? v : Math.max(max, v);
        }
      }
      if (no) out[no] = { min, max };
    }
    return out;
  }

  /**
   * roomNum 探測法：roomNum=10→5→1 の順に一括照会し、
   * { tiers, charges } を返す。
   *   tiers[hotelId]   = 10(≥10室) | 5(5–9室) | 1(1–4室) | 0(空きなし/未掲載) | null(hotelNo 不明)
   *   charges[hotelId] = { min, max } 円/室・泊（データが取れなければ未設定）
   */
  async function probeVacancy(hotels, checkinDate) {
    const tiers = {};
    const charges = {};
    for (const h of hotels) tiers[h.id] = h.rakutenHotelNo ? 0 : null;
    let remaining = hotels.filter(h => h.rakutenHotelNo);
    if (remaining.length === 0) return { tiers, charges };

    const checkin = checkinDate || new Date().toISOString().slice(0, 10);
    const out = new Date(checkin + "T00:00:00");
    out.setDate(out.getDate() + 1);
    const checkout = out.toISOString().slice(0, 10);

    for (const roomNum of [10, 5, 1]) {
      if (remaining.length === 0) break;
      // hotelNo は 15 軒/リクエスト上限
      const found = new Set();
      for (let i = 0; i < remaining.length; i += 15) {
        const batch = remaining.slice(i, i + 15);
        const body = await request("vacant", {
          hotelNo: batch.map(h => h.rakutenHotelNo).join(","),
          checkinDate: checkin, checkoutDate: checkout,
          adultNum: 1, roomNum, datumType: 1
        });
        if (!body.notFound) {
          for (const info of extractBasicInfos(body)) found.add(String(info.hotelNo));
          const priced = extractCharges(body);
          // 価格は最初にヒットした照会のものを採用（後続ラウンドで上書きしない）
          for (const h of batch) {
            const c = priced[String(h.rakutenHotelNo)];
            if (c && !charges[h.id] && (c.min || c.max)) charges[h.id] = c;
          }
        }
      }
      remaining = remaining.filter(h => {
        if (found.has(String(h.rakutenHotelNo))) { tiers[h.id] = roomNum; return false; }
        return true;
      });
    }
    return { tiers, charges };
  }

  // ---------- 施設情報同期（電話・総室数を楽天公式データで更新） ----------

  function getFacts() {
    try { return JSON.parse(localStorage.getItem(LS_FACTS) || "{}"); } catch (e) { return {}; }
  }

  /** formatVersion=2 のレスポンス各パートから任意キーを横断検索 */
  function deepFind(parts, key) {
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      if (part[key] !== undefined) return part[key];
      for (const section of Object.values(part)) {
        if (section && typeof section === "object" && section[key] !== undefined) return section[key];
      }
    }
    return undefined;
  }

  /**
   * HotelDetailSearch(responseType=large) で各ホテルの telephoneNo / hotelRoomNum を取得。
   * hotelNo は 1 リクエスト 1 軒のため全 14 軒で約 15 秒（節流 1.1s）。結果は localStorage に永続化。
   */
  async function syncHotelFacts(hotels, onProgress) {
    const facts = getFacts();
    const targets = hotels.filter(h => h.rakutenHotelNo);
    let done = 0, updated = 0;
    for (const h of targets) {
      try {
        const body = await request("detail", {
          hotelNo: h.rakutenHotelNo, responseType: "large", datumType: 1
        });
        if (!body.notFound && body.hotels && body.hotels.length) {
          const first = body.hotels[0];
          const parts = Array.isArray(first) ? first : first.hotel || [];
          const tel = deepFind(parts, "telephoneNo");
          const rooms = parseInt(deepFind(parts, "hotelRoomNum"), 10);
          facts[h.id] = {
            phone: tel || null,
            rooms: Number.isFinite(rooms) && rooms > 0 ? rooms : null,
            handicapped: deepFind(parts, "handicappedFacilities") || null,
            at: new Date().toISOString().slice(0, 10)
          };
          updated++;
        }
      } catch (e) {
        if (e.isKeyError) throw e; // key 異常は即中断、個別失敗は続行
      }
      if (onProgress) onProgress(++done, targets.length);
    }
    try { localStorage.setItem(LS_FACTS, JSON.stringify(facts)); } catch (e) { /* ignore */ }
    return updated;
  }

  return {
    getAppId, setAppId, getAccessKey, setAccessKey, isV2,
    testKey, resolveHotelNos, probeVacancy, getFacts, syncHotelFacts
  };
})();
