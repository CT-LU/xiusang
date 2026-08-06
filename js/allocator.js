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

  function emptyBreakdown() {
    return {
      crew:       { pax: 0, rooms: 0 },
      premium:    { pax: 0, rooms: 0 },
      accessible: { pax: 0, rooms: 0 },
      family:     { groups: 0, pax: 0, rooms: 0 },
      economy:    { pax: 0, rooms: 0 }
    };
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

    const familySizes = buildFamilySizes(input.familyGroups, input.familyAvgSize);
    const familyPax = familySizes.reduce((a, b) => a + b, 0);
    let economyPax = input.totalPax - input.premiumPax - input.wheelchairPax - familyPax;

    const result = {
      assignments: [],
      unassigned: { crew: 0, premium: 0, accessible: 0, familyGroups: 0, familyPax: 0, economy: 0 },
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
      breakdown: emptyBreakdown()
    }));

    const take = (s, pool, pax, rooms) => {
      s.rooms -= rooms;
      s.breakdown[pool].pax += pax;
      s.breakdown[pool].rooms += rooms;
    };

    // ---- Pass 1: 乗務員（指定ホテル → 溢出は最寄り tier1）----
    let crewLeft = Math.max(0, input.crewCount | 0);
    for (const s of st.filter(s => s.hotel.crewDesignated).sort(byTierDrive)) {
      if (crewLeft <= 0) break;
      const n = Math.min(crewLeft, s.rooms);
      if (n > 0) { take(s, "crew", n, n); crewLeft -= n; }
    }
    if (crewLeft > 0) {
      let overflowPlaced = 0;
      for (const s of st.filter(s => !s.hotel.crewDesignated && s.hotel.tier === 1).sort(byDrive)) {
        if (crewLeft <= 0) break;
        const n = Math.min(crewLeft, s.rooms);
        if (n > 0) { take(s, "crew", n, n); crewLeft -= n; overflowPlaced += n; }
      }
      if (overflowPlaced > 0)
        validation.push({ severity: "warn", code: "crew-overflow", params: { n: overflowPlaced } });
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

    // ---- Pass 4: 家族（原子単位・絶対に分割しない。First-Fit Decreasing）----
    const sortedFamilies = [...familySizes].sort((a, b) => b - a);
    const hotelsNear = [...st].sort(byDrive);
    let unplacedFamilies = 0, unplacedFamilyPax = 0;
    for (const size of sortedFamilies) {
      const roomsNeeded = Math.ceil(size / occ.familyMaxPerRoom);
      const s = hotelsNear.find(s => s.rooms >= roomsNeeded);
      if (s) {
        take(s, "family", size, roomsNeeded);
        s.breakdown.family.groups += 1;
      } else {
        unplacedFamilies += 1;
        unplacedFamilyPax += size;
      }
    }
    if (unplacedFamilies > 0) {
      result.unassigned.familyGroups = unplacedFamilies;
      result.unassigned.familyPax = unplacedFamilyPax;
      validation.push({ severity: "error", code: "family-unplaced", params: { n: unplacedFamilies } });
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
      const totalPax = b.crew.pax + b.premium.pax + b.accessible.pax + b.family.pax + b.economy.pax;
      const totalRooms = b.crew.rooms + b.premium.rooms + b.accessible.rooms + b.family.rooms + b.economy.rooms;
      const asg = {
        hotelId: s.hotel.id,
        hotel: s.hotel,
        breakdown: b,
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
      totalPax: 0, premiumPax: 0, familyGroups: 0, familyAvgSize: 3,
      wheelchairPax: 0, crewCount: 0, busCapacity: 45, busesAvailable: 6,
      occupancy: { economy: 2, premium: 1, crew: 1, familyMaxPerRoom: 4 }
    }, over);
  }

  /** 守恒検査：各プール 分配+未安置 = 入力、房数 ≤ cap */
  function conservationCheck(name, input, hotels, r, failures) {
    const sum = pool => r.assignments.reduce((a, s) => a + s.breakdown[pool].pax, 0);
    const familySizes = buildFamilySizes(input.familyGroups, input.familyAvgSize);
    const familyPax = familySizes.reduce((a, b) => a + b, 0);
    const checks = [
      ["crew",   sum("crew") + r.unassigned.crew, Math.max(0, input.crewCount)],
      ["acc",    sum("accessible") + r.unassigned.accessible, Math.max(0, input.wheelchairPax)],
      ["family", sum("family") + r.unassigned.familyPax, familyPax],
      ["prem+eco", sum("premium") + sum("economy") + r.unassigned.economy,
        Math.max(0, input.totalPax - input.wheelchairPax - familyPax)]
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

  return { allocate, runSelfTests, buildFamilySizes };
})();
