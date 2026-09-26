-- D1: catalog_oracles のカード名部分一致検索用 FTS5（trigram）インデックス。
-- LIKE '%q%' は全行スキャン（1回約2万行読み取り）になり、検索だけで日次500万行の上限に迫ったため（2026-09-26）。
-- 外部コンテンツ方式なので本体テーブルは変えず、トリガーで追従させる。
CREATE VIRTUAL TABLE IF NOT EXISTS catalog_oracles_fts USING fts5(
  name, printed_name_ja,
  content='catalog_oracles', content_rowid='rowid', tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS catalog_oracles_fts_ai AFTER INSERT ON catalog_oracles BEGIN
  INSERT INTO catalog_oracles_fts(rowid, name, printed_name_ja) VALUES (new.rowid, new.name, new.printed_name_ja);
END;
CREATE TRIGGER IF NOT EXISTS catalog_oracles_fts_ad AFTER DELETE ON catalog_oracles BEGIN
  INSERT INTO catalog_oracles_fts(catalog_oracles_fts, rowid, name, printed_name_ja) VALUES ('delete', old.rowid, old.name, old.printed_name_ja);
END;
CREATE TRIGGER IF NOT EXISTS catalog_oracles_fts_au AFTER UPDATE OF name, printed_name_ja ON catalog_oracles BEGIN
  INSERT INTO catalog_oracles_fts(catalog_oracles_fts, rowid, name, printed_name_ja) VALUES ('delete', old.rowid, old.name, old.printed_name_ja);
  INSERT INTO catalog_oracles_fts(rowid, name, printed_name_ja) VALUES (new.rowid, new.name, new.printed_name_ja);
END;

INSERT INTO catalog_oracles_fts(catalog_oracles_fts) VALUES ('rebuild');
