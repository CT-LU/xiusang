"use strict";
/**
 * 成田空港周辺ホテル静的データ / 成田機場周邊飯店靜態資料
 *
 * ※ totalRooms・usableRooms・accessibleRooms・phone は推定値です。運用開始前に必ず各ホテルへ電話確認してください。
 * ※ 房數與電話皆為估計值，正式使用前務必逐家電話核對。
 * ※ rakutenHotelNo は初回 API 利用時に SimpleHotelSearch で自動解決され localStorage にキャッシュされます。
 *
 * tier: 1=フルサービス(上級) 2=標準 3=エコノミー
 */
const HOTELS = [
  { id: "nikko-narita",    nameJa: "ホテル日航成田",                     lat: 35.7721, lng: 140.3710, driveMinutes: 10, totalRooms: 700, usableRooms: 250, accessible: true,  accessibleRooms: 4, phone: "0476-32-0032", rakutenHotelNo: null, crewDesignated: true,  tier: 1 },
  { id: "ana-crowne",      nameJa: "ANAクラウンプラザホテル成田",         lat: 35.7800, lng: 140.3650, driveMinutes: 10, totalRooms: 440, usableRooms: 150, accessible: true,  accessibleRooms: 3, phone: "0476-33-1311", rakutenHotelNo: null, crewDesignated: false, tier: 1 },
  { id: "hilton-narita",   nameJa: "ヒルトン成田",                       lat: 35.7560, lng: 140.3620, driveMinutes: 12, totalRooms: 550, usableRooms: 180, accessible: true,  accessibleRooms: 4, phone: "0476-33-1121", rakutenHotelNo: null, crewDesignated: false, tier: 1 },
  { id: "tobu-airport",    nameJa: "成田東武ホテルエアポート",           lat: 35.7740, lng: 140.3760, driveMinutes: 8,  totalRooms: 490, usableRooms: 170, accessible: true,  accessibleRooms: 2, phone: "0476-32-1234", rakutenHotelNo: null, crewDesignated: false, tier: 2 },
  { id: "marroad",         nameJa: "マロウドインターナショナルホテル成田", lat: 35.7660, lng: 140.3680, driveMinutes: 10, totalRooms: 200, usableRooms: 80,  accessible: true,  accessibleRooms: 2, phone: "0476-30-2222", rakutenHotelNo: null, crewDesignated: false, tier: 2 },
  { id: "intl-garden",     nameJa: "インターナショナルガーデンホテル成田", lat: 35.7830, lng: 140.3450, driveMinutes: 15, totalRooms: 460, usableRooms: 160, accessible: true,  accessibleRooms: 2, phone: "0476-23-5522", rakutenHotelNo: null, crewDesignated: false, tier: 2 },
  { id: "excel-tokyu",     nameJa: "成田エクセルホテル東急",             lat: 35.7710, lng: 140.3520, driveMinutes: 15, totalRooms: 700, usableRooms: 240, accessible: true,  accessibleRooms: 3, phone: "0476-33-0109", rakutenHotelNo: null, crewDesignated: false, tier: 2 },
  { id: "view-hotel",      nameJa: "成田ビューホテル",                   lat: 35.7840, lng: 140.3480, driveMinutes: 15, totalRooms: 500, usableRooms: 170, accessible: true,  accessibleRooms: 2, phone: "0476-32-1111", rakutenHotelNo: null, crewDesignated: false, tier: 2 },
  { id: "welco-narita",    nameJa: "ホテルウェルコ成田",                 lat: 35.7590, lng: 140.3390, driveMinutes: 20, totalRooms: 490, usableRooms: 160, accessible: true,  accessibleRooms: 2, phone: "0476-93-1234", rakutenHotelNo: null, crewDesignated: false, tier: 2 },
  { id: "toyoko-inn",      nameJa: "東横INN成田空港",                    lat: 35.7670, lng: 140.3310, driveMinutes: 15, totalRooms: 700, usableRooms: 230, accessible: false, accessibleRooms: 1, phone: "0476-33-1045", rakutenHotelNo: null, crewDesignated: false, tier: 3 },
  { id: "apa-keisei",      nameJa: "アパホテル京成成田駅前",             lat: 35.7770, lng: 140.3180, driveMinutes: 20, totalRooms: 490, usableRooms: 160, accessible: false, accessibleRooms: 1, phone: "0476-20-3111", rakutenHotelNo: null, crewDesignated: false, tier: 3 },
  { id: "richmond",        nameJa: "リッチモンドホテル成田",             lat: 35.7760, lng: 140.3160, driveMinutes: 20, totalRooms: 210, usableRooms: 80,  accessible: false, accessibleRooms: 1, phone: "0476-24-6660", rakutenHotelNo: null, crewDesignated: false, tier: 3 },
  { id: "center-hotel",    nameJa: "センターホテル成田２",               lat: 35.7758, lng: 140.3185, driveMinutes: 20, totalRooms: 150, usableRooms: 60,  accessible: false, accessibleRooms: 0, phone: "0476-23-1133", rakutenHotelNo: null, crewDesignated: false, tier: 3 },
  { id: "comfort",         nameJa: "コンフォートホテル成田",             lat: 35.7720, lng: 140.3160, driveMinutes: 20, totalRooms: 130, usableRooms: 50,  accessible: false, accessibleRooms: 0, phone: "0476-24-6311", rakutenHotelNo: null, crewDesignated: false, tier: 3 }
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
  familyGroups: 18,
  familyAvgSize: 3,
  wheelchairPax: 2,
  crewCount: 14,
  busCapacity: 45,
  busesAvailable: 6,
  occupancy: { economy: 2, premium: 1, crew: 1, familyMaxPerRoom: 4 }
};

/** 楽天 geo 備援検索の 2 つの円心（searchRadius 上限 3km 対応） */
const GEO_SEARCH_CENTERS = [
  { name: "空港エリア",   lat: 35.7700, lng: 140.3680 },
  { name: "成田駅エリア", lat: 35.7760, lng: 140.3180 }
];
