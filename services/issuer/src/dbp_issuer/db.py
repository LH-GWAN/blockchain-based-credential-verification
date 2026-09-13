"""SQLite 저장소. 개인정보 원본 컬럼은 없다 — jti, holder DID, claim, 상태 인덱스, 시각만."""
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
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS status_list (
  list_id TEXT PRIMARY KEY,
  bits BLOB NOT NULL,
  version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS receipts (
  hash TEXT PRIMARY KEY,
  kind INTEGER NOT NULL,
  tx_hash TEXT,
  created_at INTEGER NOT NULL
);
"""


class Store:
    def __init__(self, path: str):
        self.path = path
        with self.conn() as c:
            c.executescript(SCHEMA)

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
    def add_credential(self, jti: str, holder_did: str, claim: str, status_index: int, valid_from: str, valid_until: str) -> None:
        with self.conn() as c:
            c.execute("INSERT INTO credentials(jti,holder_did,claim,status_index,issued_at,valid_from,valid_until) VALUES(?,?,?,?,?,?,?)",
                      (jti, holder_did, claim, status_index, int(time.time()), valid_from, valid_until))

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

    def mark_revoked(self, jti: str) -> None:
        with self.conn() as c:
            c.execute("UPDATE credentials SET revoked=1, revoked_at=? WHERE jti=?", (int(time.time()), jti))

    def clear_credentials(self) -> None:
        with self.conn() as c:
            c.execute("DELETE FROM credentials")

    # status list
    def get_status_list(self, list_id: str) -> tuple[bytes, int] | None:
        with self.conn() as c:
            r = c.execute("SELECT bits, version FROM status_list WHERE list_id=?", (list_id,)).fetchone()
            return (bytes(r["bits"]), int(r["version"])) if r else None

    def put_status_list(self, list_id: str, bits: bytes, version: int) -> None:
        with self.conn() as c:
            c.execute("INSERT INTO status_list(list_id,bits,version) VALUES(?,?,?) ON CONFLICT(list_id) DO UPDATE SET bits=excluded.bits, version=excluded.version",
                      (list_id, bits, version))

    # receipts
    def add_receipt(self, h: str, kind: int, tx_hash: str | None) -> None:
        with self.conn() as c:
            c.execute("INSERT OR REPLACE INTO receipts(hash,kind,tx_hash,created_at) VALUES(?,?,?,?)", (h, kind, tx_hash, int(time.time())))
