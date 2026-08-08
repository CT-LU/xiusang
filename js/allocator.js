"use strict";
/**
 * 分配引擎（純函式、DOM 非依存）
 * allocate(input, hotels) → 分配結果
 * runSelfTests()          → ?selftest=1 で console 実行される自己検証
 */
const Allocator = (() => {

  /** 家庭人數序列：familyGroups 組，總和 = round(groups × avg)，尾差由前面幾組吸收 */
  function buildFamilySizes(groups, avgSize) {
    groups = Math.max(0, Math.floor(groups));
    if (groups === 0) return [];
    const total = Math.max(groups, Math.round(groups * avgSize));
    const base = Math.floor(total / groups);
    const rem = total - base * groups;
    const sizes = [];
    for (let i = 0; i < groups; i++) sizes.push(base + (i < rem ? 1 : 0));
    return sizes;
  }

  /** 登録グループの種別。同一グループは必ず同一ホテル（分割しない）。 */
  const PARTY_KINDS = ["family", "group", "solo"];
  const DEFAULT_MAX_PER_ROOM = { family: 4, group: 2, solo: 1 };

  function maxPerRoom(occ, kind) {
    const m = (occ && occ.partyMaxPerRoom) || {};
    // familyMaxPerRoom は旧仕様の入力（家族のみだった頃）との互換
    if (kind === "family" && !m.family && occ && occ.familyMaxPerRoom) return occ.familyMaxPerRoom;
    return Math.max(1, m[kind] || DEFAULT_MAX_PER_ROOM[kind] || 1);
  }

  /**
   * 入力のグループ一覧を正規化する。
   * input.parties があればそれを使い、無ければ旧仕様（familyGroups × familyAvgSize）から家族として生成。
   * @returns {Array} [{ no, kind, size, seats, rooms, hotelId }]
   */
  function buildParties(input) {
    const occ = input.occupancy || {};
    const src = Array.isArray(input.parties) && input.parties.length
      ? input.parties
      : buildFamilySizes(input.familyGroups, input.familyAvgSize).map(size => ({ kind: "family", size }));
    const out = [];
    for (const p of src) {
      const size = Math.max(1, Math.floor(p.size) || 0);
      if (!size) continue;
      const kind = PARTY_KINDS.includes(p.kind) ? p.kind : "family";
      out.push({
        no: out.length + 1,
        kind, size,
        seats: (p.seats || "").trim(),
        rooms: Math.ceil(size / maxPerRoom(occ, kind)),
        hotelId: null
      });
    }
    return out;
  }

  function emptyBreakdown() {
    return {
      crew:       { pax: 0, rooms: 0 },
      premium:    { pax: 0, rooms: 0 },
      accessible: { pax: 0, rooms: 0 },
      family:     { groups: 0, pax: 0, rooms: 0 },
      group:      { groups: 0, pax: 0, rooms: 0 },
      solo:       { groups: 0, pax: 0, rooms: 0 },
      economy:    { pax: 0, rooms: 0 }
    };
  }

  /** 登録グループ 3 種の合計（表示・集計用） */
  function partyTotals(b) {
    return PARTY_KINDS.reduce((a, k) => ({
      groups: a.groups + b[k].groups, pax: a.pax + b[k].pax, rooms: a.rooms + b[k].rooms
    }), { groups: 0, pax: 0, rooms: 0 });
  }

  const byDrive = (a, b) =>
    a.hotel.driveMinutes - b.hotel.driveMinutes || a.hotel.id.localeCompare(b.hotel.id);
  const byTierDrive = (a, b) =>
    a.hotel.tier - b.hotel.tier || byDrive(a, b);

  /**
   * @param {object} input  入力（DEFAULTS 参照）
   * @param {Array}  hotels 利用可能ホテル（除外済み・usableRooms 上書き済み）
   */
  function allocate(input, hotels) {
    const validation = [];
    const occ = input.occupancy;

    const parties = buildParties(input);
    const partyPax = parties.reduce((a, p) => a + p.size, 0);
    let economyPax = input.totalPax - input.premiumPax - input.wheelchairPax - partyPax;

    const result = {
      assignments: [],
      parties, // 登録グループ一覧（分配後は hotelId が入る。名簿印刷で使用）
      unassigned: { crew: 0, premium: 0, accessible: 0, partyGroups: 0, partyPax: 0, economy: 0 },
      validation,
      totals: { pax: 0, rooms: 0, trips: 0, lastReturnMin: 0 },
      ok: true
    };

    if (economyPax < 0) {
      validation.push({ severity: "error", code: "input-invalid", params: { n: -economyPax } });
      result.ok = false;
      return result;
    }

    // ホテル状態（残室を pass ごとに減算）
    const st = hotels.map(h => ({
      hotel: h,
      rooms: Math.max(0, h.usableRooms | 0),
      accRooms: Math.min(h.accessibleRooms | 0, Math.max(0, h.usableRooms | 0)),
      breakdown: emptyBreakdown(),
      parties: [] // このホテルに入るグループ（入力順で保持）
    }));

    const take = (s, pool, pax, rooms) => {
      s.rooms -= rooms;
      s.breakdown[pool].pax += pax;
      s.breakdown[pool].rooms += rooms;
    };

    // ---- Pass 1: 乗務員 ----
    // ① 指定ホテル → ② 最寄り tier1 → ③ 等級不問で最寄り
    // tier1 は「強い優先」であって満室・除外時の絶対条件ではない（休息時間確保 > 4分の車程差）。
    // ③ まで使い切って残った場合のみ未手配（＝圏内に空室ゼロ）＝範囲拡大で解消しうる。
    let crewLeft = Math.max(0, input.crewCount | 0);
    for (const s of st.filter(s => s.hotel.crewDesignated).sort(byTierDrive)) {
      if (crewLeft <= 0) break;
      const n = Math.min(crewLeft, s.rooms);
      if (n > 0) { take(s, "crew", n, n); crewLeft -= n; }
    }
    if (crewLeft > 0) {
      const fillCrew = list => {
        let placed = 0;
        for (const s of list) {
          if (crewLeft <= 0) break;
          const n = Math.min(crewLeft, s.rooms);
          if (n > 0) { take(s, "crew", n, n); crewLeft -= n; placed += n; }
        }
        return placed;
      };
      const toTier1 = fillCrew(st.filter(s => !s.hotel.crewDesignated && s.hotel.tier === 1).sort(byDrive));
      // ③ 上級ホテルが満室／除外された場合の最終手段（既に使い切った分は rooms=0 で自然に飛ばされる）
      const toLower = fillCrew([...st].sort(byDrive));

      // 振替先ごとに別メッセージ（合算すると「上級ホテルへ」と「上級が無い」が矛盾する）
      if (toTier1 > 0)
        validation.push({ severity: "warn", code: "crew-overflow", params: { n: toTier1 } });
      if (toLower > 0)
        validation.push({ severity: "warn", code: "crew-lower-tier", params: { n: toLower } });
      if (crewLeft > 0) {
        result.unassigned.crew = crewLeft;
        validation.push({ severity: "error", code: "crew-unplaced", params: { n: crewLeft } });
      }
    }

    // ---- Pass 2: バリアフリー（対応ホテル → 溢出は最寄り一般室）----
    let accLeft = Math.max(0, input.wheelchairPax | 0);
    for (const s of st.filter(s => s.hotel.accessible).sort(byDrive)) {
      if (accLeft <= 0) break;
      const n = Math.min(accLeft, s.accRooms, s.rooms);
      if (n > 0) { take(s, "accessible", n, n); s.accRooms -= n; accLeft -= n; }
    }
    if (accLeft > 0) {
      let overflowPlaced = 0;
      for (const s of [...st].sort(byDrive)) {
        if (accLeft <= 0) break;
        const n = Math.min(accLeft, s.rooms);
        if (n > 0) { take(s, "accessible", n, n); accLeft -= n; overflowPlaced += n; }
      }
      if (overflowPlaced > 0)
        validation.push({ severity: "warn", code: "accessible-overflow", params: { n: overflowPlaced } });
      if (accLeft > 0) {
        result.unassigned.accessible = accLeft;
        validation.push({ severity: "error", code: "accessible-unplaced", params: { n: accLeft } });
      }
    }

    // ---- Pass 3: C/F クラス（tier→距離、1人/室。不足分はエコノミーへ合流）----
    let premLeft = Math.max(0, input.premiumPax | 0);
    let premInLowerTier = 0;
    for (const s of [...st].sort(byTierDrive)) {
      if (premLeft <= 0) break;
      const n = Math.min(premLeft, s.rooms);
      if (n > 0) {
        take(s, "premium", n, n);
        premLeft -= n;
        if (s.hotel.tier >= 2) premInLowerTier += n;
      }
    }
    if (premInLowerTier > 0)
      validation.push({ severity: "info", code: "premium-downgrade", params: { n: premInLowerTier } });
    if (premLeft > 0) {
      validation.push({ severity: "info", code: "premium-to-economy", params: { n: premLeft } });
      economyPax += premLeft;
      premLeft = 0;
    }

    // ---- Pass 4: 登録グループ（家族・団体・個人。原子単位・絶対に分割しない。First-Fit Decreasing）----
    // 必要室数の多い順に置く。部屋数こそが奪い合う資源なので、人数ではなく室数で降順にする。
    const sortedParties = [...parties].sort((a, b) => b.rooms - a.rooms || b.size - a.size || a.no - b.no);
    const hotelsNear = [...st].sort(byDrive);
    let unplacedParties = 0, unplacedPartyPax = 0;
    for (const p of sortedParties) {
      const s = hotelsNear.find(s => s.rooms >= p.rooms);
      if (s) {
        take(s, p.kind, p.size, p.rooms);
        s.breakdown[p.kind].groups += 1;
        p.hotelId = s.hotel.id;
        s.parties.push(p);
      } else {
        unplacedParties += 1;
        unplacedPartyPax += p.size;
      }
    }
    for (const s of st) s.parties.sort((a, b) => a.no - b.no);
    if (unplacedParties > 0) {
      result.unassigned.partyGroups = unplacedParties;
      result.unassigned.partyPax = unplacedPartyPax;
      validation.push({ severity: "error", code: "party-unplaced",
        params: { n: unplacedParties, pax: unplacedPartyPax } });
    }

    // ---- Pass 5: エコノミー（距離順に詰めて次へ、2人/室）----
    let ecoLeft = economyPax;
    for (const s of hotelsNear) {
      if (ecoLeft <= 0) break;
      const capPax = s.rooms * occ.economy;
      const n = Math.min(ecoLeft, capPax);
      if (n > 0) {
        take(s, "economy", n, Math.ceil(n / occ.economy));
        ecoLeft -= n;
      }
    }
    if (ecoLeft > 0) {
      result.unassigned.economy = ecoLeft;
      validation.push({ severity: "error", code: "capacity-short", params: { n: ecoLeft } });
    }

    // ---- 集計・バス配車 ----
    const busCapacity = Math.max(1, input.busCapacity | 0);
    const busesAvailable = Math.max(1, input.busesAvailable | 0);
    const trips = [];

    for (const s of st) {
      const b = s.breakdown;
      const pt = partyTotals(b);
      const totalPax = b.crew.pax + b.premium.pax + b.accessible.pax + pt.pax + b.economy.pax;
      const totalRooms = b.crew.rooms + b.premium.rooms + b.accessible.rooms + pt.rooms + b.economy.rooms;
      const asg = {
        hotelId: s.hotel.id,
        hotel: s.hotel,
        breakdown: b,
        parties: s.parties,
        partyTotals: pt,
        totalPax, totalRooms,
        vacancyTier: null,
        needsPhoneConfirm: false,
        busCount: 0,
        busBatches: []
      };
      if (totalPax > 0) {
        const n = Math.ceil(totalPax / busCapacity);
        asg.busCount = n;
        const base = Math.floor(totalPax / n), rem = totalPax - base * n;
        const roundTripMin = 2 * s.hotel.driveMinutes + 25; // 乗車15分 + 降車10分
        for (let i = 0; i < n; i++) {
          const batch = { batch: i + 1, pax: base + (i < rem ? 1 : 0), departOffsetMin: 0, roundTripMin };
          asg.busBatches.push(batch);
          trips.push({ asg, batch, driveMinutes: s.hotel.driveMinutes });
        }
      }
      result.assignments.push(asg);
      result.totals.pax += totalPax;
      result.totals.rooms += totalRooms;
    }

    // バス貪欲スケジューリング：近いホテル優先、最も早く空く車両に割当
    trips.sort((a, b) => a.driveMinutes - b.driveMinutes || a.asg.hotelId.localeCompare(b.asg.hotelId) || a.batch.batch - b.batch.batch);
    const busFreeAt = new Array(Math.min(busesAvailable, Math.max(1, trips.length))).fill(0);
    for (const t of trips) {
      let idx = 0;
      for (let i = 1; i < busFreeAt.length; i++) if (busFreeAt[i] < busFreeAt[idx]) idx = i;
      t.batch.departOffsetMin = busFreeAt[idx];
      busFreeAt[idx] += t.batch.roundTripMin;
      result.totals.lastReturnMin = Math.max(result.totals.lastReturnMin, t.batch.departOffsetMin + t.batch.roundTripMin);
    }
    result.totals.trips = trips.length;

    // ---- 結果メッセージ ----
    const anyError = validation.some(v => v.severity === "error");
    if (anyError) {
      result.ok = false;
    } else {
      validation.push({ severity: "info", code: "all-placed", params: { n: result.totals.pax } });
      const leftover = st.reduce((a, s) => a + s.rooms, 0);
      if (leftover === 0)
        validation.push({ severity: "info", code: "capacity-exact", params: {} });
    }
    return result;
  }

  // ============================ 費用予測 ============================

  /**
   * 分配結果 × 単価 → 概算費用。分配そのものには影響しない後段の集計。
   * @param {object} result allocate() の戻り値
   * @param {object} rates  {
   *   roomUnit: { [hotelId]: { amount, source } },  // source: manual | rakuten | tier
   *   busPerTrip, mealPerPax, contingencyPct
   * }
   * 宿泊は「1室単価 × 割当室数」。バスは車次（往復1回）単位、食事は手配人数（乗務員含む）単位。
   */
  function estimateCost(result, rates) {
    const byHotel = [];
    let roomAmount = 0;
    for (const a of result.assignments) {
      if (a.totalRooms <= 0) continue;
      const u = (rates.roomUnit && rates.roomUnit[a.hotelId]) || { amount: 0, source: "tier" };
      const amount = Math.max(0, u.amount | 0) * a.totalRooms;
      roomAmount += amount;
      byHotel.push({ hotelId: a.hotelId, rooms: a.totalRooms, unit: u.amount | 0, source: u.source, amount });
    }
    const bus = {
      trips: result.totals.trips, unit: rates.busPerTrip | 0,
      amount: result.totals.trips * Math.max(0, rates.busPerTrip | 0)
    };
    const meal = {
      pax: result.totals.pax, unit: rates.mealPerPax | 0,
      amount: result.totals.pax * Math.max(0, rates.mealPerPax | 0)
    };
    const subtotal = roomAmount + bus.amount + meal.amount;
    const pct = Math.max(0, rates.contingencyPct || 0);
    const contingency = { pct, amount: Math.round(subtotal * pct / 100) };
    const total = subtotal + contingency.amount;
    return {
      room: { amount: roomAmount, byHotel },
      bus, meal, contingency, subtotal, total,
      perPax: result.totals.pax > 0 ? Math.round(total / result.totals.pax) : 0,
      // 単価の出所内訳（報告書に「何軒が推定値のままか」を出すため）
      sources: byHotel.reduce((acc, r) => { acc[r.source] = (acc[r.source] || 0) + 1; return acc; }, {})
    };
  }

  // ============================ 自己検証 ============================

  function mockHotel(id, over) {
    return Object.assign({
      id, nameJa: id, lat: 35.77, lng: 140.36, driveMinutes: 10,
      totalRooms: 100, usableRooms: 100, accessible: false, accessibleRooms: 0,
      phone: "", rakutenHotelNo: null, crewDesignated: false, tier: 2
    }, over);
  }

  function baseInput(over) {
    return Object.assign({
      totalPax: 0, premiumPax: 0, parties: [], familyGroups: 0, familyAvgSize: 3,
      wheelchairPax: 0, crewCount: 0, busCapacity: 45, busesAvailable: 6,
      occupancy: { economy: 2, premium: 1, crew: 1, partyMaxPerRoom: { family: 4, group: 2, solo: 1 } }
    }, over);
  }

  /** 守恒検査：各プール 分配+未安置 = 入力、房数 ≤ cap */
  function conservationCheck(name, input, hotels, r, failures) {
    const sum = pool => r.assignments.reduce((a, s) => a + s.breakdown[pool].pax, 0);
    const sumParties = () => PARTY_KINDS.reduce((a, k) => a + sum(k), 0);
    const partyPax = buildParties(input).reduce((a, p) => a + p.size, 0);
    const checks = [
      ["crew",   sum("crew") + r.unassigned.crew, Math.max(0, input.crewCount)],
      ["acc",    sum("accessible") + r.unassigned.accessible, Math.max(0, input.wheelchairPax)],
      ["party",  sumParties() + r.unassigned.partyPax, partyPax],
      ["prem+eco", sum("premium") + sum("economy") + r.unassigned.economy,
        Math.max(0, input.totalPax - input.wheelchairPax - partyPax)]
    ];
    for (const [pool, got, want] of checks) {
      if (got !== want) failures.push(`${name}: 守恒NG ${pool} got=${got} want=${want}`);
    }
    for (const a of r.assignments) {
      const h = hotels.find(h => h.id === a.hotelId);
      if (a.totalRooms > h.usableRooms) failures.push(`${name}: ${a.hotelId} 房数超過 ${a.totalRooms}>${h.usableRooms}`);
    }
  }

  function runSelfTests() {
    const failures = [];
    const ok = (cond, msg) => { if (!cond) failures.push(msg); };

    // 1. 典型 320 名欠航（実データ使用）
    {
      const input = baseInput({ totalPax: 320, premiumPax: 24, familyGroups: 18, familyAvgSize: 3, wheelchairPax: 2, crewCount: 14 });
      const r = allocate(input, HOTELS);
      ok(r.ok, "T1: 典型320名で ok=false");
      ok(r.totals.pax === 320 + 14, `T1: 総分配数 ${r.totals.pax} ≠ 334`);
      ok(r.assignments.some(a => a.hotelId === "nikko-narita" && a.breakdown.crew.pax === 14), "T1: 乗務員が日航に入っていない");
      conservationCheck("T1", input, HOTELS, r, failures);
    }
    // 2. 容量不足
    {
      const hotels = [mockHotel("small", { usableRooms: 10 })];
      const input = baseInput({ totalPax: 100 });
      const r = allocate(input, hotels);
      ok(!r.ok, "T2: 容量不足なのに ok=true");
      ok(r.unassigned.economy === 80, `T2: 未安置 ${r.unassigned.economy} ≠ 80`);
      ok(r.validation.some(v => v.code === "capacity-short"), "T2: capacity-short 警告なし");
      conservationCheck("T2", input, hotels, r, failures);
    }
    // 3. 全ゼロ入力
    {
      const r = allocate(baseInput({}), HOTELS);
      ok(r.ok && r.totals.pax === 0 && r.totals.trips === 0, "T3: 全ゼロで異常");
    }
    // 4. 巨大家族（8名 → 2室、同一ホテル）
    {
      const input = baseInput({ totalPax: 8, familyGroups: 1, familyAvgSize: 8 });
      const r = allocate(input, HOTELS);
      const fam = r.assignments.filter(a => a.breakdown.family.pax > 0);
      ok(fam.length === 1 && fam[0].breakdown.family.rooms === 2 && fam[0].breakdown.family.pax === 8,
        "T4: 8名家族が 1ホテル2室 になっていない");
      conservationCheck("T4", input, HOTELS, r, failures);
    }
    // 5. 車椅子 > バリアフリー室（溢出 warn）
    {
      const hotels = [
        mockHotel("acc", { accessible: true, accessibleRooms: 2, driveMinutes: 5 }),
        mockHotel("gen", { driveMinutes: 8 })
      ];
      const input = baseInput({ totalPax: 5, wheelchairPax: 5 });
      const r = allocate(input, hotels);
      ok(r.validation.some(v => v.code === "accessible-overflow"), "T5: accessible-overflow なし");
      ok(r.unassigned.accessible === 0, "T5: 一般室で吸収できていない");
      conservationCheck("T5", input, hotels, r, failures);
    }
    // 6. 乗務員指定ホテル満室 → 最寄り tier1 溢出
    {
      const hotels = [
        mockHotel("desig", { crewDesignated: true, usableRooms: 3, tier: 1 }),
        mockHotel("t1b",   { tier: 1, driveMinutes: 12 })
      ];
      const input = baseInput({ crewCount: 10 });
      const r = allocate(input, hotels);
      ok(r.validation.some(v => v.code === "crew-overflow"), "T6: crew-overflow なし");
      const t1b = r.assignments.find(a => a.hotelId === "t1b");
      ok(t1b.breakdown.crew.pax === 7, `T6: 溢出数 ${t1b.breakdown.crew.pax} ≠ 7`);
      conservationCheck("T6", input, hotels, r, failures);
    }
    // 6b. tier1 が全滅（満室・除外）でも乗務員は最寄りの下位ホテルへ落ちる
    {
      const hotels = [
        mockHotel("desig", { crewDesignated: true, usableRooms: 2, tier: 1, driveMinutes: 10 }),
        mockHotel("far2",  { tier: 2, driveMinutes: 25, usableRooms: 50 }),
        mockHotel("near3", { tier: 3, driveMinutes: 8,  usableRooms: 50 })
      ];
      const input = baseInput({ crewCount: 10 });
      const r = allocate(input, hotels);
      ok(r.unassigned.crew === 0, `T6b: 未手配 ${r.unassigned.crew} 名（下位ホテルへ落ちていない）`);
      ok(!r.validation.some(v => v.code === "crew-unplaced"), "T6b: crew-unplaced が出ている");
      ok(r.validation.some(v => v.code === "crew-lower-tier"), "T6b: crew-lower-tier なし");
      const near3 = r.assignments.find(a => a.hotelId === "near3");
      ok(near3 && near3.breakdown.crew.pax === 8,
        `T6b: 最寄り優先が効いていない（near3 = ${near3 ? near3.breakdown.crew.pax : 0} 名 ≠ 8）`);
      conservationCheck("T6b", input, hotels, r, failures);
    }
    // 6c. 圏内に空室ゼロのときだけ crew-unplaced（範囲拡大で解消しうる状態）
    {
      const hotels = [mockHotel("full", { usableRooms: 0, tier: 2 })];
      const input = baseInput({ totalPax: 0, crewCount: 4 });
      const r = allocate(input, hotels);
      ok(r.unassigned.crew === 4, `T6c: 未手配 ${r.unassigned.crew} ≠ 4`);
      ok(r.validation.some(v => v.code === "crew-unplaced"), "T6c: crew-unplaced なし");
      conservationCheck("T6c", input, hotels, r, failures);
    }
    // 7. バス1台の多波次（発車オフセットが累積する）
    {
      const hotels = [mockHotel("h", { driveMinutes: 10, usableRooms: 100 })];
      const input = baseInput({ totalPax: 100, busCapacity: 45, busesAvailable: 1 });
      const r = allocate(input, hotels);
      const batches = r.assignments[0].busBatches;
      ok(batches.length === 3, `T7: 車次数 ${batches.length} ≠ 3`);
      ok(batches[1].departOffsetMin === 45 && batches[2].departOffsetMin === 90,
        `T7: オフセット ${batches.map(b => b.departOffsetMin)} ≠ 0,45,90`);
      ok(r.totals.lastReturnMin === 135, `T7: lastReturn ${r.totals.lastReturnMin} ≠ 135`);
    }
    // 8b. 距離圏フォールバック：zone1 だけでは不足する大人数も全域なら収容できる
    {
      const zone1 = HOTELS.filter(h => h.zone === 1);
      const input = baseInput({ totalPax: 4200 });
      const near = allocate(input, zone1);
      ok(!near.ok && near.unassigned.economy > 0, "T8b: zone1 のみで不足が検出されない");
      const all = allocate(input, HOTELS);
      ok(all.ok, "T8b: 全域でも 4200 名を収容できない");
      conservationCheck("T8b", input, HOTELS, all, failures);
    }
    // 9. 費用予測：内訳の合算と予備費が一致する
    {
      const hotels = [mockHotel("h", { usableRooms: 100, driveMinutes: 10 })];
      const input = baseInput({ totalPax: 100, busCapacity: 50, busesAvailable: 4 });
      const r = allocate(input, hotels);
      const c = estimateCost(r, {
        roomUnit: { h: { amount: 10000, source: "tier" } },
        busPerTrip: 40000, mealPerPax: 3000, contingencyPct: 10
      });
      // 100名/2名1室 = 50室 → 50万、車次 2 → 8万、食事 100名 → 30万
      ok(c.room.amount === 500000, `T9: 宿泊費 ${c.room.amount} ≠ 500000`);
      ok(c.bus.amount === r.totals.trips * 40000, `T9: バス費 ${c.bus.amount} が車次×単価と不一致`);
      ok(c.meal.amount === 300000, `T9: 食事代 ${c.meal.amount} ≠ 300000`);
      ok(c.subtotal === c.room.amount + c.bus.amount + c.meal.amount, "T9: 小計が内訳合計と不一致");
      ok(c.contingency.amount === Math.round(c.subtotal * 0.1), "T9: 予備費が小計の10%でない");
      ok(c.total === c.subtotal + c.contingency.amount, "T9: 総額が小計＋予備費と不一致");
      ok(c.perPax === Math.round(c.total / 100), `T9: 1名あたり ${c.perPax} が総額/人数と不一致`);
    }
    // 9b. 単価ゼロ・空結果でも壊れない（オフラインで単価未設定のケース）
    {
      const r = allocate(baseInput({}), HOTELS);
      const c = estimateCost(r, { roomUnit: {}, busPerTrip: 0, mealPerPax: 0, contingencyPct: 5 });
      ok(c.total === 0 && c.perPax === 0, "T9b: 全ゼロ入力で費用が 0 にならない");
    }
    // 10. グループ登録：種別ごとの1室あたり人数（家族4・団体2・個人1）で室数が決まる
    {
      const hotels = [mockHotel("h", { usableRooms: 50 })];
      const input = baseInput({
        totalPax: 20,
        parties: [
          { kind: "family", size: 5, seats: "32A-32E" }, // 5名 → 2室
          { kind: "group",  size: 12, seats: "40A-45F" }, // 12名 → 6室
          { kind: "solo",   size: 1, seats: "12C" }       // 1名 → 1室
        ]
      });
      const r = allocate(input, hotels);
      const b = r.assignments[0].breakdown;
      ok(b.family.rooms === 2 && b.group.rooms === 6 && b.solo.rooms === 1,
        `T10: 室数 家族${b.family.rooms}/団体${b.group.rooms}/個人${b.solo.rooms} ≠ 2/6/1`);
      ok(b.family.groups === 1 && b.group.groups === 1 && b.solo.groups === 1, "T10: 組数が 1/1/1 でない");
      ok(r.assignments[0].parties.length === 3, "T10: ホテルにグループ明細が付いていない");
      ok(r.assignments[0].parties[0].seats === "32A-32E", "T10: 座席番号が結果に引き継がれていない");
      ok(r.parties.every(p => p.hotelId === "h"), "T10: 全グループが同一ホテルに入っていない");
      // 残り 20-18=2 名は一般（2名/室 → 1室）
      ok(b.economy.pax === 2 && b.economy.rooms === 1, `T10: 一般 ${b.economy.pax}名/${b.economy.rooms}室 ≠ 2名/1室`);
      conservationCheck("T10", input, hotels, r, failures);
    }
    // 11. グループは絶対に分割しない（1軒では足りない大団体は残室の多い方へ丸ごと入る）
    {
      const hotels = [
        mockHotel("near", { usableRooms: 3, driveMinutes: 5 }),
        mockHotel("far",  { usableRooms: 20, driveMinutes: 30 })
      ];
      const input = baseInput({ totalPax: 16, parties: [{ kind: "group", size: 16 }] });
      const r = allocate(input, hotels);
      const near = r.assignments.find(a => a.hotelId === "near");
      const far = r.assignments.find(a => a.hotelId === "far");
      ok(near.breakdown.group.pax === 0 && far.breakdown.group.pax === 16,
        "T11: 16名団体が近い方へ分割されている（不分割違反）");
      ok(r.parties[0].hotelId === "far", "T11: グループの割当先ホテルが記録されていない");
      conservationCheck("T11", input, hotels, r, failures);
    }
    // 12. どのホテルにも入らないグループは未手配として報告（人数も出す）
    {
      const hotels = [mockHotel("tiny", { usableRooms: 1 })];
      const input = baseInput({ totalPax: 9, parties: [{ kind: "family", size: 9 }] }); // 9名 → 3室
      const r = allocate(input, hotels);
      ok(!r.ok && r.unassigned.partyGroups === 1 && r.unassigned.partyPax === 9,
        `T12: 未手配 ${r.unassigned.partyGroups}組/${r.unassigned.partyPax}名 ≠ 1組/9名`);
      ok(r.validation.some(v => v.code === "party-unplaced"), "T12: party-unplaced なし");
      conservationCheck("T12", input, hotels, r, failures);
    }
    // 8. 入力矛盾（内訳 > 総数）
    {
      const r = allocate(baseInput({ totalPax: 10, premiumPax: 20 }), HOTELS);
      ok(!r.ok && r.validation.some(v => v.code === "input-invalid"), "T8: 入力矛盾が検出されない");
    }

    const passed = failures.length === 0;
    (passed ? console.info : console.error)(
      `[Allocator selftest] ${passed ? "ALL PASS" : "FAILED"}`, failures);
    return { passed, failures };
  }

  return { allocate, estimateCost, runSelfTests, buildFamilySizes, buildParties, partyTotals, PARTY_KINDS };
})();
