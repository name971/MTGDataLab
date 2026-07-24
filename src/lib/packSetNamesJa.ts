/**
 * セット名の日本語版（Wizards公式の日本語製品名）。Scryfall/MTGJSONは英語名しか
 * 提供しないため手動で維持する。scripts/generate-pack-data.mjsが再生成しても
 * このファイルは上書きされない（別ファイルなので）。
 * 未掲載のセットコードは英語名にフォールバックする（呼び出し側で対応）。
 */
export const SET_NAME_JA: Record<string, string> = {
  blb: "ブルームバロウ",
  dsk: "ダスクモーン：戦慄の館",
  dft: "霊気走破",
  tdm: "タルキール:龍嵐録",
  fdn: "ファウンデーションズ",
  mkm: "カルロフ邸殺人事件",
  otj: "サンダー・ジャンクションの無法者",
  // 以下8件はユーザーから提示された公式製品名をそのまま使用（プレフィックスも省略しない）
  msh: "マジック：ザ・ギャザリング｜マーベル スーパー・ヒーローズ",
  sos: "ストリクスヘイヴンの秘密",
  tmt: "マジック：ザ・ギャザリング | ミュータント タートルズ",
  ecl: "ローウィンの昏明",
  tla: "マジック：ザ・ギャザリング | アバター 伝説の少年アン",
  spm: "マジック：ザ・ギャザリング | マーベル スパイダーマン",
  eoe: "久遠の終端",
  fin: "マジック：ザ・ギャザリング——FINAL FANTASY",
};

export function setNameJa(setCode: string, fallbackEnName: string): string {
  return SET_NAME_JA[setCode] ?? fallbackEnName;
}
