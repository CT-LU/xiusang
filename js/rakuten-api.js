"use strict";
/**
 * 楽天トラベルAPI クライアント
 * - 節流：リクエスト間隔 1.1 秒、429 は指数バックオフで 2 回まで再試行
 * - CORS 実測済み（Access-Control-Allow-Origin: *）。fetch 失敗時は JSONP に自動フォールバック
 * - VacantHotelSearch は空室「数」を返さないため roomNum=10→5→1 の探測で階層化する
 * - hotelNo はカンマ区切りで一括最大 15 軒。初回に SimpleHotelSearch(geo) で自動解決し localStorage にキャッシュ
 */
const RakutenAPI = (() => {
  const BASE = "https://app.rakuten.co.jp/services/api/Travel";
  const VACANT = `${BASE}/VacantHotelSearch/20170426`;
  const SIMPLE = `${BASE}/SimpleHotelSearch/20170426`;
  const DETAIL = `${BASE}/HotelDetailSearch/20170426`;
  const LS_APP_ID = "narita.rakutenAppId";
  const LS_HOTEL_NOS = "narita.rakutenHotelNos.v1";
  const LS_FACTS = "narita.hotelFacts.v1";
  const GAP_MS = 1100;
  const TIMEOUT_MS = 10000;

  let lastRequestAt = 0;
  let queue = Promise.resolve();
  let jsonpCounter = 0;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function getAppId() { try { return localStorage.getItem(LS_APP_ID) || ""; } catch (e) { return ""; } }
  function setAppId(id) { try { localStorage.setItem(LS_APP_ID, id.trim()); } catch (e) { /* private mode */ } }

  function buildUrl(endpoint, params) {
    const q = new URLSearchParams(Object.assign({
      applicationId: getAppId(),
      format: "json",
      formatVersion: "2"
    }, params));
    return `${endpoint}?${q.toString()}`;
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
   */
  function request(endpoint, params) {
    const run = async () => {
      const url = buildUrl(endpoint, params);
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
          // ネットワーク/CORS 失敗 → JSONP フォールバック（一度だけ）
          body = await jsonpFetch(url);
          res = null;
        }
        if (body && body.error === "not_found") return { notFound: true };
        if (res && res.status === 429 && attempt < 2) { await sleep(2000 * Math.pow(2, attempt)); continue; }
        if (body && body.error) {
          const err = new Error(`${body.error}: ${body.error_description || ""}`);
          err.isKeyError = /applicationId|application_id/i.test(body.error_description || "");
          throw err;
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
    const body = await request(SIMPLE, {
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
        const body = await request(SIMPLE, {
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
   * roomNum 探測法：roomNum=10→5→1 の順に一括照会し、
   * hotelId → 10(≥10室) | 5(5–9室) | 1(1–4室) | 0(空きなし/未掲載) | null(hotelNo 不明) を返す。
   */
  async function probeVacancy(hotels, checkinDate) {
    const tiers = {};
    for (const h of hotels) tiers[h.id] = h.rakutenHotelNo ? 0 : null;
    let remaining = hotels.filter(h => h.rakutenHotelNo);
    if (remaining.length === 0) return tiers;

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
        const body = await request(VACANT, {
          hotelNo: batch.map(h => h.rakutenHotelNo).join(","),
          checkinDate: checkin, checkoutDate: checkout,
          adultNum: 1, roomNum, datumType: 1
        });
        if (!body.notFound) {
          for (const info of extractBasicInfos(body)) found.add(String(info.hotelNo));
        }
      }
      remaining = remaining.filter(h => {
        if (found.has(String(h.rakutenHotelNo))) { tiers[h.id] = roomNum; return false; }
        return true;
      });
    }
    return tiers;
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
        const body = await request(DETAIL, {
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

  return { getAppId, setAppId, testKey, resolveHotelNos, probeVacancy, getFacts, syncHotelFacts };
})();
