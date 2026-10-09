"""SQLite 저장소. 개인정보 원본 컬럼은 없다 — jti, holder DID, claim, 상태 인덱스, 규칙 번들 버전, 시각만."""
from __future__ import annotations

import sqlite3
import time
from contextlib import contextmanager

SCHEMA = """
CREATE TABLE IF NOT EXISTS credentials (
  jti TEXT PRIMARY KEY,
  holder_did TEXT NOT NULL,
  claim TEXT NOT NULL,
  status_index INTEGER NOT NULL UNIQUE,
  issued_at INTEGER NOT NULL,
  valid_from TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER,
  bundle TEXT,
  bundle_version TEXT
);
CREATE TABLE IF NOT EXISTS status_list (
  list_id TEXT PRIMARY KEY,
  bits BLOB NOT NULL,
  version INTEGER NOT NULL,
  dirty INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS receipts (
  hash TEXT PRIMARY KEY,
  kind INTEGER NOT NULL,
  tx_hash TEXT,
  created_at INTEGER NOT NULL
);
"""

# 기존 DB(.demo 등)를 제자리에서 올리는 컬럼 추가분: (테이블, 컬럼, 정의)
# 마이그레이션 전에 발급된 행은 번들 버전을 알 수 없어 NULL 로 남고, 일괄 폐기 대상에서 빠진다.
MIGRATIONS = [
    ("credentials", "bundle", "TEXT"),
    ("credentials", "bundle_version", "TEXT"),
    ("status_list", "dirty", "INTEGER NOT NULL DEFAULT 0"),
]


class Store:
    def __init__(self, path: str):
        self.path = path
        with self.conn() as c:
            c.executescript(SCHEMA)
            for table, col, decl in MIGRATIONS:
                cols = {r["name"] for r in c.execute(f"PRAGMA table_info({table})")}
                if col not in cols:
                    c.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")

    @contextmanager
    def conn(self):
        c = sqlite3.connect(self.path)
        c.row_factory = sqlite3.Row
        try:
            yield c
            c.commit()
        finally:
            c.close()

    # credentials
    def add_credential(self, jti: str, holder_did: str, claim: str, status_index: int, valid_from: str, valid_until: str,
                       bundle: str | None = None, bundle_version: str | None = None) -> None:
        with self.conn() as c:
            c.execute("INSERT INTO credentials(jti,holder_did,claim,status_index,issued_at,valid_from,valid_until,bundle,bundle_version)"
                      " VALUES(?,?,?,?,?,?,?,?,?)",
                      (jti, holder_did, claim, status_index, int(time.time()), valid_from, valid_until, bundle, bundle_version))

    def get_credential(self, jti: str) -> dict | None:
        with self.conn() as c:
            r = c.execute("SELECT * FROM credentials WHERE jti=?", (jti,)).fetchone()
            return dict(r) if r else None

    def list_credentials(self) -> list[dict]:
        with self.conn() as c:
            return [dict(r) for r in c.execute("SELECT * FROM credentials ORDER BY issued_at DESC, jti")]

    def used_indices(self) -> set[int]:
        with self.conn() as c:
            return {int(r[0]) for r in c.execute("SELECT status_index FROM credentials")}

    def credentials_by_bundle(self, bundle: str, bundle_version: str) -> list[dict]:
        with self.conn() as c:
            return [dict(r) for r in c.execute("SELECT * FROM credentials WHERE bundle=? AND bundle_version=? ORDER BY jti",
                                               (bundle, bundle_version))]

    def mark_revoked(self, jti: str) -> None:
        with self.conn() as c:
            c.execute("UPDATE credentials SET revoked=1, revoked_at=COALESCE(revoked_at, ?) WHERE jti=?", (int(time.time()), jti))

    def clear_credentials(self) -> None:
        with self.conn() as c:
            c.execute("DELETE FROM credentials")

    # status list
    def get_status_list(self, list_id: str) -> tuple[bytes, int] | None:
        with self.conn() as c:
            r = c.execute("SELECT bits, version FROM status_list WHERE list_id=?", (list_id,)).fetchone()
            return (bytes(r["bits"]), int(r["version"])) if r else None

    def put_status_list(self, list_id: str, bits: bytes, version: int, dirty: bool | None = None) -> None:
        """dirty=None 이면 기존 미게시 표시를 그대로 둔다."""
        with self.conn() as c:
            c.execute("INSERT INTO status_list(list_id,bits,version,dirty) VALUES(?,?,?,?) ON CONFLICT(list_id) DO UPDATE SET"
                      " bits=excluded.bits, version=excluded.version, dirty=COALESCE(?, status_list.dirty)",
                      (list_id, bits, version, int(bool(dirty)), None if dirty is None else int(dirty)))

    def status_list_dirty(self, list_id: str) -> bool:
        """로컬 변경이 아직 원장에 게시되지 않았는지 (게시 실패 후 재게시 대상)."""
        with self.conn() as c:
            r = c.execute("SELECT dirty FROM status_list WHERE list_id=?", (list_id,)).fetchone()
            return bool(r and r["dirty"])

    def set_status_list_dirty(self, list_id: str, dirty: bool) -> None:
        with self.conn() as c:
            c.execute("UPDATE status_list SET dirty=? WHERE list_id=?", (int(dirty), list_id))

    # receipts
    def add_receipt(self, h: str, kind: int, tx_hash: str | None) -> None:
        with self.conn() as c:
            c.execute("INSERT OR REPLACE INTO receipts(hash,kind,tx_hash,created_at) VALUES(?,?,?,?)", (h, kind, tx_hash, int(time.time())))

    def set_receipt_tx(self, h: str, tx_hash: str) -> None:
        with self.conn() as c:
            c.execute("UPDATE receipts SET tx_hash=? WHERE hash=?", (tx_hash, h))

    def get_receipt(self, h: str) -> dict | None:
        with self.conn() as c:
            r = c.execute("SELECT hash, kind, tx_hash, created_at FROM receipts WHERE hash=?", (h,)).fetchone()
            return dict(r) if r else None
