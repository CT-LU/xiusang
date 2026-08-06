"use strict";
/**
 * 動的メッセージの中日辞書。静的ラベルは index.html に直接双語表記。
 * t(code, params) → { zh, ja }
 */
const I18N = (() => {
  const MSG = {
    "input-invalid":       { zh: "輸入矛盾：分項人數合計超過總旅客數 {n} 人，請修正輸入",
                             ja: "入力エラー：内訳の合計が総旅客数を{n}名超えています。入力を確認してください" },
    "crew-overflow":       { zh: "組員指定飯店客滿，{n} 名組員改配至最近的上級飯店",
                             ja: "乗務員指定ホテル満室のため、{n}名を最寄りの上位ホテルへ振替えました" },
    "crew-unplaced":       { zh: "{n} 名組員無法安置，需人工處理",
                             ja: "乗務員{n}名が未手配です。個別対応が必要です" },
    "accessible-overflow": { zh: "無障礙房不足，{n} 名旅客改配一般房——請向飯店要求低樓層房並電話確認",
                             ja: "バリアフリールーム不足のため{n}名を一般客室に割当——低層階の部屋を電話で要確認" },
    "accessible-unplaced": { zh: "{n} 名無障礙需求旅客無法安置",
                             ja: "バリアフリー対応が必要な旅客{n}名が未手配です" },
    "premium-downgrade":   { zh: "上級飯店客滿，{n} 名 C/F 艙旅客配至標準飯店",
                             ja: "上級ホテル満室のため、C/Fクラス{n}名を標準ホテルに割当てました" },
    "premium-to-economy":  { zh: "單人房額度用罄，{n} 名 C/F 艙旅客併入一般分配（2人/房）",
                             ja: "シングル利用枠がなくなり、C/Fクラス{n}名を一般割当（2名/室）に統合しました" },
    "family-unplaced":     { zh: "{n} 組家庭找不到同一飯店的足夠房間（不拆散原則），需人工安排",
                             ja: "{n}組の家族が同一ホテルで確保できません（分割しない方針）。個別対応が必要です" },
    "capacity-short":      { zh: "尚有 {n} 名旅客未能安置——請放寬可用房數、解除除外飯店，或聯絡更遠的飯店",
                             ja: "{n}名の旅客が未手配です——利用可能室数の緩和、除外解除、または遠方ホテルへの連絡を検討してください" },
    "capacity-exact":      { zh: "可用房數已全數用完，方案無任何緩衝，建議追加備援飯店",
                             ja: "利用可能室数を使い切りました。バッファがないため予備ホテルの追加を推奨します" },
    "all-placed":          { zh: "全員 {n} 名（含組員）安置完成",
                             ja: "全{n}名（乗務員含む）の手配が完了しました" },
    "needs-phone":         { zh: "分配數超過線上可見空房，需電話確認",
                             ja: "割当数がオンライン空室数を超えています。電話で要確認" },
    "offline-mode":        { zh: "離線模式：使用內建估計資料，空房請以電話確認",
                             ja: "オフラインモード：内蔵推定データ使用中。空室は電話でご確認ください" },
    "api-ok":              { zh: "楽天 API 連線正常",
                             ja: "楽天APIに接続しました" },
    "api-fail":            { zh: "楽天 API 連線失敗：{msg}",
                             ja: "楽天APIへの接続に失敗：{msg}" },
    "api-no-key":          { zh: "未設定楽天 applicationId，以離線模式運作",
                             ja: "楽天applicationId未設定のため、オフラインモードで動作します" },
    "api-probing":         { zh: "正在查詢線上空房…",
                             ja: "オンライン空室を照会中…" },
    "api-probe-done":      { zh: "線上空房查詢完成（{n} 家有資料）",
                             ja: "オンライン空室の照会が完了しました（{n}軒でデータあり）" },
    "vacancy-note":        { zh: "線上可見空房遠低於電話可徵用數，僅供排序參考",
                             ja: "オンライン空室は電話で確保できる室数より大幅に少ないため、参考値です" }
  };

  const VACANCY_LABEL = {
    10:   { zh: "≥10 房", ja: "≥10室" },
    5:    { zh: "5–9 房", ja: "5–9室" },
    1:    { zh: "1–4 房", ja: "1–4室" },
    0:    { zh: "0（未上架）", ja: "0（掲載なし）" },
    null: { zh: "—", ja: "—" }
  };

  function fmt(str, params) {
    return String(str).replace(/\{(\w+)\}/g, (_, k) =>
      params && params[k] !== undefined ? params[k] : `{${k}}`);
  }

  function t(code, params) {
    const m = MSG[code] || { zh: code, ja: code };
    return { zh: fmt(m.zh, params), ja: fmt(m.ja, params) };
  }

  function vacancyLabel(tier) {
    return VACANCY_LABEL[tier === null || tier === undefined ? null : tier] || VACANCY_LABEL[null];
  }

  return { t, vacancyLabel };
})();
