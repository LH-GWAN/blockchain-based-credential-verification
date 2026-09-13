from __future__ import annotations

import logging
import os
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

from dbp_rules import load_bundle, load_policies

from .config import Settings
from .datasource import SeedDataSource
from .db import Store
from .ledger_iface import FakeLedger, Ledger
from .service import IssuerService

log = logging.getLogger("dbp_issuer")


class ChallengeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    holderDid: str


class Consent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scope: list[str]
    ts: str


class IssueIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    citizenId: str = Field(description="모사 로그인 식별자 (실서비스: 모바일 신분증 인증)")
    holderDid: str
    holderProof: str = Field(description="홀더 키로 서명한 챌린지 JWS")
    requestedClaims: list[str]
    consent: Consent


def build_ledger(settings: Settings) -> Ledger | None:
    if os.environ.get("LEDGER_FAKE") == "1":
        from dbp_rules import bundle_hash
        return FakeLedger(bundle_hash(load_bundle(settings.bundle, settings.version)))
    try:
        from dbp_ledger import LedgerClient
        lc = LedgerClient(rpc_url=settings.rpc_url, private_key=settings.evm_private_key)
        if not lc.is_connected():
            log.warning("ledger not reachable at %s", settings.rpc_url)
        return lc
    except Exception as e:
        log.warning("ledger client unavailable: %s", e)
        return None


def create_app(settings: Settings | None = None, ledger: Ledger | None = None, store: Store | None = None) -> FastAPI:
    settings = settings or Settings()
    store = store or Store(settings.db_path)
    ledger = ledger if ledger is not None else build_ledger(settings)
    svc = IssuerService(settings, store, ledger, SeedDataSource(settings.known_fields))
    app = FastAPI(title=f"대구 혜택패스 발급기관 — {settings.name}", version="0.1.0")
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
    app.state.svc = svc

    @app.get("/health")
    def health():
        return {"ok": True, "issuer": settings.did, "ledgerConnected": bool(ledger and ledger.is_connected())}

    @app.get("/.well-known/issuer")
    def well_known():
        return svc.well_known()

    @app.get("/rules/bundles/{bundle}/{version}")
    def get_bundle(bundle: str, version: str):
        if (bundle, version) != (settings.bundle, settings.version):
            raise HTTPException(404, "BUNDLE_UNKNOWN")
        return svc.bundle

    @app.get("/policies")
    def policies():
        return load_policies()

    @app.get("/citizens")
    def citizens():
        """모사 로그인용 식별자 목록 (개인정보 없음)."""
        return svc.ds.list_ids()

    @app.post("/credentials/challenge")
    def challenge(body: ChallengeIn):
        return svc.new_challenge(body.holderDid)

    @app.post("/credentials/issue")
    def issue(body: IssueIn):
        try:
            svc.verify_holder_proof(body.holderDid, body.holderProof)
        except Exception as e:
            raise HTTPException(401, f"HOLDER_PROOF_INVALID:{e}")
        if set(body.consent.scope) != set(body.requestedClaims):
            raise HTTPException(400, "CONSENT_SCOPE_MISMATCH")
        try:
            return svc.issue(body.citizenId, body.holderDid, body.requestedClaims, body.consent.ts)
        except LookupError as e:
            raise HTTPException(404, str(e))
        except ValueError as e:
            raise HTTPException(400, str(e))
        except RuntimeError as e:
            raise HTTPException(503, str(e))

    @app.get("/status-list")
    def status_list():
        return svc.status_list_info()

    @app.get("/admin/credentials")
    def admin_list():
        rows = svc.store.list_credentials()
        for r in rows:
            r["holderDidShort"] = r["holder_did"][:20] + "…"
            r["label"] = svc.labels.get(r["claim"], r["claim"])
            del r["holder_did"]
        return {"issuer": {"did": settings.did, "name": settings.name}, "credentials": rows,
                "statusList": {k: v for k, v in svc.status_list_info().items() if k != "encoded"}}

    @app.post("/admin/credentials/{jti:path}/revoke")
    def admin_revoke(jti: str):
        try:
            return svc.revoke(jti)
        except LookupError as e:
            raise HTTPException(404, str(e))

    @app.post("/admin/demo/reset")
    def admin_reset():
        return svc.reset_demo()

    return app
