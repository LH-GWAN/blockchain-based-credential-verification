"""합성 시민 30명 생성기. 전부 가명·가상 데이터. 결정론적(seed 고정).

경계값을 고르게 포함한다: 기준선 정확히 일치, ±1원, 가구원수 1~6, 대구 외 거주, 65세 미만,
학생 자녀 가구, 수급자, 신용 구간, 세대원(세대주 아님)·한부모(미혼 2인 가구)·비재직. C-001은 시연 페르소나(68세 1인 가구 대구 북구, 월 100만 원).
"""
from __future__ import annotations

import json
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MEDIAN = json.loads((ROOT / "data/median-income-2026.json").read_text())["byHouseholdSize"]

SURNAMES = ["김", "이", "박", "최", "정", "강", "조", "윤", "장", "임", "한", "오", "서", "신", "권"]
GIVEN = ["복례", "순자", "영희", "철수", "민수", "지영", "현우", "수진", "미경", "동현", "은주", "성호", "정숙", "태영", "하늘",
         "보람", "경호", "말순", "옥분", "재훈", "소연", "기태", "유진", "병철", "선미", "광수", "혜진", "종석", "명자", "다은"]
DAEGU_GU = ["북구", "남구", "동구", "서구", "중구", "수성구", "달서구", "달성군", "군위군"]
OTHER = [("경상북도", "경산시"), ("경상북도", "구미시"), ("부산광역시", "해운대구"), ("서울특별시", "관악구")]


def line(hs: int, pct: int) -> int:
    """income*100 <= median*pct 를 만족하는 최대 정수 소득."""
    return (int(MEDIAN[str(min(hs, 6))]) * pct) // 100


def citizen(i: int, *, birth: str, sido: str, sigungu: str, hs: int, income: int, recipient=False,
            student=False, credit="other", annual=None, head=None, married=None, employed=None) -> dict:
    # 세대주·혼인·재직은 난수를 쓰지 않고 정한다 (기존 시민 값이 바뀌지 않게). 1인 가구는 본인이 세대주.
    year = int(birth[:4])
    return {
        "citizenId": f"C-{i:03d}",
        "name": SURNAMES[i % len(SURNAMES)] + GIVEN[(i - 1) % len(GIVEN)],
        "birthDate": birth,
        "residence": {"sido": sido, "sigungu": sigungu},
        "householdSize": hs,
        "monthlyIncomeKRW": income,
        "isBasicLivelihoodRecipient": recipient,
        "hasStudentChild": student,
        "creditScoreTier": credit,
        "annualIncomeKRW": annual if annual is not None else income * 12,
        "isHouseholdHead": head if head is not None else True,
        "isMarried": married if married is not None else (hs >= 2),
        "isEmployed": employed if employed is not None else (year >= 1962 and not recipient),
    }


def main() -> None:
    rows: list[dict] = []
    # 1) 시연 페르소나
    persona = citizen(1, birth="1958-03-12", sido="대구광역시", sigungu="북구", hs=1, income=1_000_000, credit="bottom20")
    persona["name"] = "김복례"
    rows.append(persona)
    # 2) 경계값: 1인 가구 32% 정확히 / +1원, 48% 정확히 / +1원, 50% 정확히 / +1원
    rows.append(citizen(2, birth="1970-05-01", sido="대구광역시", sigungu="남구", hs=1, income=line(1, 32)))
    rows.append(citizen(3, birth="1970-05-01", sido="대구광역시", sigungu="남구", hs=1, income=line(1, 32) + 1))
    rows.append(citizen(4, birth="1961-12-31", sido="대구광역시", sigungu="동구", hs=1, income=line(1, 48)))
    rows.append(citizen(5, birth="1961-12-31", sido="대구광역시", sigungu="동구", hs=1, income=line(1, 48) + 1))
    rows.append(citizen(6, birth="1990-07-07", sido="대구광역시", sigungu="서구", hs=1, income=line(1, 50)))
    rows.append(citizen(7, birth="1990-07-07", sido="대구광역시", sigungu="서구", hs=1, income=line(1, 50) + 1))
    # 3) 가구원수 2~6 경계(48% 정확히), 학생 자녀
    for hs, idx in zip(range(2, 7), range(8, 13)):
        rows.append(citizen(idx, birth="1980-01-15", sido="대구광역시", sigungu=DAEGU_GU[idx % len(DAEGU_GU)],
                            hs=hs, income=line(hs, 48), student=(hs >= 3)))
    # 4) 65세 경계: 기준일 2026-09-14 기준 만 65세 되는 날 / 하루 뒤 출생(64세)
    rows.append(citizen(13, birth="1961-09-14", sido="대구광역시", sigungu="중구", hs=1, income=1_500_000))
    rows.append(citizen(14, birth="1961-09-15", sido="대구광역시", sigungu="중구", hs=1, income=1_500_000))
    # 5) 1958/1959년생 경계(도시철도 무임), 기초연금 선정기준액 경계
    rows.append(citizen(15, birth="1958-12-31", sido="대구광역시", sigungu="수성구", hs=1, income=2_470_000))
    rows.append(citizen(16, birth="1959-01-01", sido="대구광역시", sigungu="수성구", hs=1, income=2_470_001))
    rows.append(citizen(17, birth="1955-06-06", sido="대구광역시", sigungu="달서구", hs=2, income=3_952_000))
    rows.append(citizen(18, birth="1955-06-06", sido="대구광역시", sigungu="달서구", hs=2, income=3_952_001))
    # 6) 대구 외 거주 (3명)
    for idx, (sido, sg) in zip(range(19, 22), OTHER):
        rows.append(citizen(idx, birth="1957-02-02", sido=sido, sigungu=sg, hs=1, income=900_000, credit="bottom20"))
    # 7) 수급자 (에너지바우처·통신감면), 65세 이상/미만
    rows.append(citizen(22, birth="1950-10-10", sido="대구광역시", sigungu="달성군", hs=1, income=700_000, recipient=True))
    rows.append(citizen(23, birth="1985-10-10", sido="대구광역시", sigungu="군위군", hs=2, income=1_200_000, recipient=True, student=True,
                        married=False))
    # 8) 소액생계비대출 경계: 연소득 3,500만 정확히 / +1, 신용 구간
    rows.append(citizen(24, birth="1992-03-03", sido="대구광역시", sigungu="북구", hs=1, income=2_916_666, credit="bottom20", annual=35_000_000))
    rows.append(citizen(25, birth="1992-03-03", sido="대구광역시", sigungu="북구", hs=1, income=2_916_667, credit="bottom20", annual=35_000_001))
    rows.append(citizen(26, birth="1988-08-08", sido="대구광역시", sigungu="남구", hs=3, income=2_000_000, credit="other", head=False))
    # 9) 연소득 4,500만 경계 (신용 하위 20% + 3,500만 초과): 정확히 / +1원
    rows.append(citizen(27, birth="1975-04-04", sido="대구광역시", sigungu="서구", hs=2, income=3_750_000, credit="bottom20", annual=45_000_000))
    rows.append(citizen(28, birth="1975-04-04", sido="대구광역시", sigungu="서구", hs=2, income=3_750_001, credit="bottom20", annual=45_000_001))
    # 10) 무작위 2명 (seed 고정)
    rng = random.Random(20260914)
    for idx in range(29, 31):
        hs = rng.randint(1, 6)
        income = rng.randint(500_000, 6_000_000)
        rows.append(citizen(idx, birth=f"{rng.randint(1945, 2000)}-{rng.randint(1, 12):02d}-{rng.randint(1, 28):02d}",
                            sido="대구광역시", sigungu=rng.choice(DAEGU_GU), hs=hs, income=income,
                            credit=rng.choice(["bottom20", "other"]), student=rng.random() < 0.4))
    assert len(rows) == 30
    out = ROOT / "data/citizens.json"
    out.write_text(json.dumps({"notice": "전원 가명·합성 데이터. 실존 인물과 무관.", "citizens": rows},
                              ensure_ascii=False, indent=2) + "\n")
    print(f"wrote {out} ({len(rows)} citizens)")


if __name__ == "__main__":
    main()
