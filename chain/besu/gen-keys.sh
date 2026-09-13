#!/usr/bin/env bash
# Besu QBFT 로컬 데모용 검증자 키/제네시스 생성 (결정론적).  로컬 데모 전용 — 키가 공개적으로 재현 가능하다.
#
# 기본: docker 없이 Node(viem)로 생성  →  keys/, genesis.json, static-nodes.json
# 대안: 공식 튜토리얼처럼 besu 이미지로 무작위 키를 만들려면  ./gen-keys.sh --docker
#      (산출물 networkFiles/ 를 이 디렉터리 구조로 옮기고 static-nodes.json 의 enode 를 새 공개키로 바꿔야 한다)
set -euo pipefail
cd "$(dirname "$0")"

if [[ "${1:-}" == "--docker" ]]; then
  docker run --rm -v "$PWD:/work" hyperledger/besu:latest \
    operator generate-blockchain-config \
    --config-file=/work/config/qbftConfigFile.json \
    --to=/work/networkFiles \
    --private-key-file-name=key
  echo "networkFiles/ 생성됨. keys/validatorN/key 와 genesis.json, static-nodes.json 을 수동으로 갱신하세요."
  exit 0
fi

node gen-keys.ts
