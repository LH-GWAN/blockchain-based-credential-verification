from __future__ import annotations

import hmac
import logging
import os
from urllib.parse import urlparse

from dbp_rules import load_bundle, load_policies
from fastapi import APIRouter, BackgroundTasks, Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

from .config import Settings
from .datasource import SeedDataSource
from .db import Store
from .ledger_iface import FakeLedger, Ledger
from .service import IssuerService, LedgerPublishError

log = logging.getLogger("dbp_issuer")
# ADMIN_TOKEN 이 없을 때 /admin/* 을 허용하는 클라이언트 (루프백·TestClient)
LOCAL_ADMIN_HOSTS = {"127.0.0.1", "::1", "localhost", "testclient"}


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


class RevokeByBundleIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    bundle: str
    version: str


def admin_guard(settings: Settings):
    """/admin/* 접근 제한 (F10): ADMIN_TOKEN 이 있으면 X-Admin-Token 일치, 없으면 루프백 요청만."""
    def check(request: Request, x_admin_token: str | None = Header(default=None)) -> None:
        # 시연 노트북 브라우저에서 연 다른 사이트가 루프백으로 보내는 요청(CSRF)을 거른다.
        # :8001/docs·:8003/docs 같은 같은 출처와, Origin 이 없는 curl·Playwright 요청은 통과한다.
        if request.headers.get("sec-fetch-site") == "cross-site":
            raise HTTPException(403, "ADMIN_FORBIDDEN")
        origin = request.headers.get("origin")
        if origin and urlparse(origin).netloc != request.headers.get("host", ""):
            raise HTTPException(403, "ADMIN_FORBIDDEN")
        if settings.admin_token:
            if not x_admin_token or not hmac.compare_digest(x_admin_token.encode(), settings.admin_token.encode()):
                raise HTTPException(403, "ADMIN_FORBIDDEN")
            return
        host = request.client.host if request.client else ""
        if host not in LOCAL_ADMIN_HOSTS:
            raise HTTPException(403, "ADMIN_FORBIDDEN")
    return check


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
    except Exception as e:  # noqa: BLE001 — 원장 없이도 기동한다 (발급은 RULE_HASH 대조에서 막힌다)
        log.warning("ledger client unavailable: %s", e)
        return None


def create_app(settings: Settings | None = None, ledger: Ledger | None = None, store: Store | None = None) -> FastAPI:
    settings = settings or Settings()
    store = store or Store(settings.db_path)
    ledger = ledger if ledger is not None else build_ledger(settings)
    svc = IssuerService(settings, store, ledger, SeedDataSource(settings.known_fields))
    app = FastAPI(title=f"대구 혜택패스 발급기관 — {settings.name}", version="0.1.0")
    app.add_middleware(CORSMiddleware, allow_origins=settings.allowed_origins, allow_methods=["*"], allow_headers=["*"])
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

    @app.get("/ledger/deployment")
    def ledger_deployment():
        """공동원장 컨트랙트 주소·ABI (공개 정보). 지갑이 직접 원장을 읽어 규칙 해시·영수증을 대조할 때 사용."""
        try:
            # 기동 때 원장 클라이언트가 읽은 배포 정보를 우선한다 — 나중에 다른 스택이 latest.json 을 덮어써도
            # 발급기관이 실제로 쓰는 컨트랙트 주소를 알려 준다 (F17). 원장 클라이언트가 없을 때만 파일을 읽는다.
            from dbp_ledger import Deployment, load_deployment
            d = getattr(ledger, "deployment", None)
            if not isinstance(d, Deployment):
                d = load_deployment()
            return {"chainId": d.chain_id, "rpcUrl": os.environ.get("PUBLIC_RPC_URL", settings.rpc_url), "contracts": d.contracts}
        except Exception as e:  # noqa: BLE001
            raise HTTPException(503, f"DEPLOYMENT_UNAVAILABLE:{e}")

    @app.get("/citizens")
    def citizens():
        """모사 로그인용 식별자 목록 (개인정보 없음)."""
        return svc.ds.list_ids()

    @app.post("/credentials/challenge")
    def challenge(body: ChallengeIn):
        return svc.new_challenge(body.holderDid)

    @app.post("/credentials/issue")
    def issue(body: IssueIn, background: BackgroundTasks):
        try:
            svc.verify_holder_proof(body.holderDid, body.holderProof)
        except Exception as e:  # noqa: BLE001 — 서명·형식 오류 모두 401
            raise HTTPException(401, f"HOLDER_PROOF_INVALID:{e}")
        if set(body.consent.scope) != set(body.requestedClaims):
            raise HTTPException(400, "CONSENT_SCOPE_MISMATCH")
        try:
            out = svc.issue(body.citizenId, body.holderDid, body.requestedClaims, body.consent.ts)
        except LookupError as e:
            raise HTTPException(404, str(e))
        except ValueError as e:
            raise HTTPException(400, str(e))
        except RuntimeError as e:  # RULE_HASH_MISMATCH · STATUS_LIST_FULL · BUNDLE_PERIOD_ENDED …
            raise HTTPException(503, str(e))
        # 동의 영수증 앵커는 응답 뒤에 — 블록 생성이 멈춰도 발급 응답은 기다리지 않는다 (F62)
        if out["consentReceipt"]["anchor"] == "pending":
            background.add_task(svc.anchor_consent_receipt, out["consentReceipt"]["hash"])
        return out

    @app.get("/consent-receipts/{h}")
    def consent_receipt(h: str):
        """동의 영수증 앵커 진행 상태 (해시만 — 원문은 홀더만 갖는다)."""
        r = svc.consent_receipt(h)
        if r is None:
            raise HTTPException(404, "RECEIPT_UNKNOWN")
        return r

    @app.get("/status-list")
    def status_list():
        return svc.status_list_info()

    admin = APIRouter(prefix="/admin", dependencies=[Depends(admin_guard(settings))])

    @admin.get("/credentials")
    def admin_list():
        return svc.admin_credentials()

    @admin.post("/credentials/revoke-by-bundle")
    def admin_revoke_by_bundle(body: RevokeByBundleIn):
        try:
            return svc.revoke_by_bundle(body.bundle, body.version)
        except LedgerPublishError as e:
            raise HTTPException(503, str(e))

    @admin.post("/credentials/{jti:path}/revoke")
    def admin_revoke(jti: str):
        try:
            return svc.revoke(jti)
        except LookupError as e:
            raise HTTPException(404, str(e))
        except LedgerPublishError as e:  # 로컬은 폐기됨·미게시 표시 — resync 또는 다음 폐기 때 원장에 합쳐 올린다 (F07)
            raise HTTPException(503, str(e))

    @admin.post("/status-list/resync")
    def admin_resync():
        try:
            return svc.resync_status_list()
        except LedgerPublishError as e:
            raise HTTPException(503, str(e))

    @admin.post("/demo/reset")
    def admin_reset():
        return svc.reset_demo()

    app.include_router(admin)
    return app
