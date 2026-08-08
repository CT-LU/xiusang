"use strict";
/**
 * 成田空港周辺ホテル静的データ / 成田機場周邊飯店靜態資料
 *
 * ※ totalRooms・usableRooms・accessibleRooms・phone は推定値です。運用開始前に必ず各ホテルへ電話確認してください。
 *   （電話・総室数は「楽天で同期」ボタンで公式データに更新可能）
 * ※ 房數與電話皆為估計值，正式使用前務必逐家電話核對（可用同步鈕更新）。
 * ※ rakutenHotelNo は初回 API 利用時に SimpleHotelSearch で自動解決され localStorage にキャッシュされます。
 *
 * tier: 1=フルサービス(上級) 2=標準 3=エコノミー
 * zone: 1=空港近郊(〜15分) 2=成田市街(〜25分) 3=遠方圏 佐倉・印西・幕張(〜60分)
 */
const ZONES = {
  1: { ja: "空港近郊（〜15分）",              zh: "機場近郊（≤15分）" },
  2: { ja: "成田市街（〜25分）",              zh: "成田市區（≤25分）" },
  3: { ja: "遠方圏 佐倉・印西・幕張（〜60分）", zh: "遠距圈 佐倉・印西・幕張（≤60分）" }
};

const HOTELS = [
  // ---- zone 1: 空港近郊 ----
  { id: "nikko-narita",    nameJa: "ホテル日航成田",                     lat: 35.7721, lng: 140.3710, driveMinutes: 10, totalRooms: 700, usableRooms: 250, accessible: true,  accessibleRooms: 4, phone: "0476-32-0032", rakutenHotelNo: null, crewDesignated: true,  tier: 1, zone: 1 },
  { id: "ana-crowne",      nameJa: "ANAクラウンプラザホテル成田",         lat: 35.7800, lng: 140.3650, driveMinutes: 10, totalRooms: 440, usableRooms: 150, accessible: true,  accessibleRooms: 3, phone: "0476-33-1311", rakutenHotelNo: null, crewDesignated: false, tier: 1, zone: 1 },
  { id: "hilton-narita",   nameJa: "ヒルトン成田",                       lat: 35.7560, lng: 140.3620, driveMinutes: 12, totalRooms: 550, usableRooms: 180, accessible: true,  accessibleRooms: 4, phone: "0476-33-1121", rakutenHotelNo: null, crewDesignated: false, tier: 1, zone: 1 },
  { id: "mystays-premier", nameJa: "ホテルマイステイズプレミア成田",     lat: 35.7635, lng: 140.3665, driveMinutes: 12, totalRooms: 710, usableRooms: 240, accessible: true,  accessibleRooms: 3, phone: "0476-33-1600", rakutenHotelNo: null, crewDesignated: false, tier: 2, zone: 1 },
  { id: "tobu-airport",    nameJa: "成田東武ホテルエアポート",           lat: 35.7740, lng: 140.3760, driveMinutes: 8,  totalRooms: 490, usableRooms: 170, accessible: true,  accessibleRooms: 2, phone: "0476-32-1234", rakutenHotelNo: null, crewDesignated: false, tier: 2, zone: 1 },
  { id: "marroad",         nameJa: "マロウドインターナショナルホテル成田", lat: 35.7660, lng: 140.3680, driveMinutes: 10, totalRooms: 200, usableRooms: 80,  accessible: true,  accessibleRooms: 2, phone: "0476-30-2222", rakutenHotelNo: null, crewDesignated: false, tier: 2, zone: 1 },
  { id: "intl-garden",     nameJa: "インターナショナルガーデンホテル成田", lat: 35.7830, lng: 140.3450, driveMinutes: 15, totalRooms: 460, usableRooms: 160, accessible: true,  accessibleRooms: 2, phone: "0476-23-5522", rakutenHotelNo: null, crewDesignated: false, tier: 2, zone: 1 },
  { id: "excel-tokyu",     nameJa: "成田エクセルホテル東急",             lat: 35.7710, lng: 140.3520, driveMinutes: 15, totalRooms: 700, usableRooms: 240, accessible: true,  accessibleRooms: 3, phone: "0476-33-0109", rakutenHotelNo: null, crewDesignated: false, tier: 2, zone: 1 },
  { id: "view-hotel",      nameJa: "成田ビューホテル",                   lat: 35.7840, lng: 140.3480, driveMinutes: 15, totalRooms: 500, usableRooms: 170, accessible: true,  accessibleRooms: 2, phone: "0476-32-1111", rakutenHotelNo: null, crewDesignated: false, tier: 2, zone: 1 },
  { id: "toyoko-inn",      nameJa: "東横INN成田空港",                    lat: 35.7670, lng: 140.3310, driveMinutes: 15, totalRooms: 700, usableRooms: 230, accessible: false, accessibleRooms: 1, phone: "0476-33-1045", rakutenHotelNo: null, crewDesignated: false, tier: 3, zone: 1 },
  // ---- zone 2: 成田市街 ----
  { id: "welco-narita",    nameJa: "ホテルウェルコ成田",                 lat: 35.7590, lng: 140.3390, driveMinutes: 20, totalRooms: 490, usableRooms: 160, accessible: true,  accessibleRooms: 2, phone: "0476-93-1234", rakutenHotelNo: null, crewDesignated: false, tier: 2, zone: 2 },
  { id: "apa-keisei",      nameJa: "アパホテル京成成田駅前",             lat: 35.7770, lng: 140.3180, driveMinutes: 20, totalRooms: 490, usableRooms: 160, accessible: false, accessibleRooms: 1, phone: "0476-20-3111", rakutenHotelNo: null, crewDesignated: false, tier: 3, zone: 2 },
  { id: "richmond",        nameJa: "リッチモンドホテル成田",             lat: 35.7760, lng: 140.3160, driveMinutes: 20, totalRooms: 210, usableRooms: 80,  accessible: false, accessibleRooms: 1, phone: "0476-24-6660", rakutenHotelNo: null, crewDesignated: false, tier: 3, zone: 2 },
  { id: "center-hotel",    nameJa: "センターホテル成田２",               lat: 35.7758, lng: 140.3185, driveMinutes: 20, totalRooms: 150, usableRooms: 60,  accessible: false, accessibleRooms: 0, phone: "0476-23-1133", rakutenHotelNo: null, crewDesignated: false, tier: 3, zone: 2 },
  { id: "comfort",         nameJa: "コンフォートホテル成田",             lat: 35.7720, lng: 140.3160, driveMinutes: 20, totalRooms: 130, usableRooms: 50,  accessible: false, accessibleRooms: 0, phone: "0476-24-6311", rakutenHotelNo: null, crewDesignated: false, tier: 3, zone: 2 },
  { id: "gateway",         nameJa: "成田ゲートウェイホテル",             lat: 35.7442, lng: 140.3672, driveMinutes: 15, totalRooms: 200, usableRooms: 80,  accessible: false, accessibleRooms: 1, phone: "0476-35-3311", rakutenHotelNo: null, crewDesignated: false, tier: 3, zone: 2 },
  { id: "u-city",          nameJa: "成田Uシティホテル",                  lat: 35.7768, lng: 140.3230, driveMinutes: 20, totalRooms: 190, usableRooms: 70,  accessible: false, accessibleRooms: 0, phone: "0476-24-0101", rakutenHotelNo: null, crewDesignated: false, tier: 3, zone: 2 },
  // ---- zone 3: 遠方圏（佐倉・印西・幕張） ----
  { id: "wishton",         nameJa: "ウィシュトンホテル・ユーカリ",       lat: 35.7237, lng: 140.1569, driveMinutes: 40, totalRooms: 190, usableRooms: 80,  accessible: true,  accessibleRooms: 1, phone: "043-489-6111", rakutenHotelNo: null, crewDesignated: false, tier: 3, zone: 3 },
  { id: "markone-cnt",     nameJa: "ホテルマークワンCNT",                lat: 35.7970, lng: 140.1260, driveMinutes: 35, totalRooms: 130, usableRooms: 50,  accessible: false, accessibleRooms: 0, phone: "0476-48-1010", rakutenHotelNo: null, crewDesignated: false, tier: 3, zone: 3 },
  { id: "apa-makuhari",    nameJa: "アパホテル&リゾート東京ベイ幕張",    lat: 35.6480, lng: 140.0330, driveMinutes: 55, totalRooms: 2000, usableRooms: 600, accessible: true, accessibleRooms: 4, phone: "043-296-1111", rakutenHotelNo: null, crewDesignated: false, tier: 2, zone: 3 },
  { id: "springs-makuhari",nameJa: "ホテルスプリングス幕張",             lat: 35.6560, lng: 140.0430, driveMinutes: 55, totalRooms: 180, usableRooms: 70,  accessible: true,  accessibleRooms: 1, phone: "043-296-3111", rakutenHotelNo: null, crewDesignated: false, tier: 2, zone: 3 },
  { id: "greentower",      nameJa: "ホテルグリーンタワー幕張",           lat: 35.6485, lng: 140.0405, driveMinutes: 55, totalRooms: 200, usableRooms: 80,  accessible: true,  accessibleRooms: 1, phone: "043-296-1122", rakutenHotelNo: null, crewDesignated: false, tier: 2, zone: 3 }
];

const TERMINALS = [
  { id: "T1", nameJa: "第1ターミナル", lat: 35.7649, lng: 140.3861 },
  { id: "T2", nameJa: "第2ターミナル", lat: 35.7720, lng: 140.3929 },
  { id: "T3", nameJa: "第3ターミナル", lat: 35.7776, lng: 140.3899 }
];

/** 地図の連線起点（第2ターミナル付近） */
const AIRPORT_CENTER = { lat: 35.7720, lng: 140.3929 };

const DEFAULTS = {
  totalPax: 320,
  premiumPax: 24,
  // グループ未登録のときに一括生成する初期値（家族 18 組 × 3 名）。登録があればそちらが優先。
  familyGroups: 18,
  familyAvgSize: 3,
  wheelchairPax: 2,
  crewCount: 14,
  busCapacity: 45,
  busesAvailable: 6,
  /**
   * 1室あたりの人数。partyMaxPerRoom は登録グループの種別ごとの上限。
   * 家族 4（添い寝・エキストラ込み）／団体 2（知人同士の相部屋可）／個人 1（見知らぬ客を同室にしない）。
   */
  occupancy: {
    economy: 2, premium: 1, crew: 1,
    partyMaxPerRoom: { family: 4, group: 2, solo: 1 }
  }
};

/**
 * 概要ページ配置図の参照点（主要駅）。地理の見当をつけるための背景情報で、配分ロジックには一切関与しない。
 * 座標は OpenStreetMap Nominatim による実測値。図の枠内に入るものだけが描画される。
 */
const LANDMARKS = [
  { nameJa: "成田駅",       lat: 35.7778, lng: 140.3141 }, // JR・京成成田駅（約200m差のため1点に集約）
  { nameJa: "成田湯川駅",   lat: 35.7996, lng: 140.2915 },
  { nameJa: "京成酒々井駅", lat: 35.7368, lng: 140.2700 },
  { nameJa: "佐倉駅",       lat: 35.7094, lng: 140.2260 },
  { nameJa: "ユーカリが丘駅", lat: 35.7217, lng: 140.1564 },
  { nameJa: "千葉NT中央駅", lat: 35.8002, lng: 140.1163 }, // 千葉ニュータウン中央駅
  { nameJa: "海浜幕張駅",   lat: 35.6486, lng: 140.0417 }
];

/**
 * 費用予測の既定単価（円・税サービス料込み）。すべて運用判断で要調整。
 *
 * 宿泊費は「① 手動上書き → ② 楽天の実勢価格 → ③ 下記 tier 既定値」の優先順で決まる。
 * ③ はオフライン時の退路であり、欠航当日は需要急増で実勢価格がこれを上回ることが多い。
 * バス・食事は公開 API が無いため常に手動値（貸切バスは時間・距離制の契約単価を入力すること）。
 */
const COST_DEFAULTS = {
  roomByTier: { 1: 18000, 2: 13000, 3: 9000 }, // 1室1泊
  busPerTrip: 45000,   // 貸切バス 1車次（空港→ホテル往復・待機含む）
  mealPerPax: 3000,    // 1名あたり（夕食＋朝食）
  contingencyPct: 5    // 雑費・予備費（小計に対する％）
};

/** 楽天 geo 備援検索の円心（searchRadius 上限 3km 対応、各エリアをカバー） */
const GEO_SEARCH_CENTERS = [
  { name: "空港エリア",       lat: 35.7700, lng: 140.3680 },
  { name: "成田駅エリア",     lat: 35.7760, lng: 140.3180 },
  { name: "ユーカリが丘",     lat: 35.7237, lng: 140.1569 },
  { name: "千葉ニュータウン", lat: 35.7970, lng: 140.1260 },
  { name: "幕張エリア",       lat: 35.6490, lng: 140.0380 }
];
