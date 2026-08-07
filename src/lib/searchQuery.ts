/**
 * 検索クエリが発火させるのに十分な長さかどうかを判定する。
 * 英数字は2〜3文字未満だとノイズが多すぎるため2文字以上を要求するが、
 * 漢字1文字（「島」「森」等の基本土地名）はそれ単体で意味が確定するため、
 * CJK文字（ひらがな・カタカナ・漢字）を含む場合は1文字から発火させる。
 */
export function meetsMinQueryLength(query: string): boolean {
  if (/[぀-ヿ㐀-鿿]/.test(query)) return query.length >= 1;
  return query.length >= 2;
}
