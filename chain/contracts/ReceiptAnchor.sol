// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ReceiptAnchor — 동의·제출 영수증의 솔트 포함 해시 앵커
/// @notice 온체인에 저장하는 것: `sha256(JCS({kind, ..., salt}))` 32바이트 해시와 앵커 시각, 앵커한 주소뿐이다.
///         salt(32바이트 난수)와 영수증 원문은 지갑(홀더)만 보관하므로, 원장 해시만으로는 누가·무엇을·어디에
///         제출했는지 알 수 없다(발급기관도 시민의 제출 사실을 알 수 없다). 지갑은 "제출 이력" 화면에서
///         로컬 원문을 다시 해시해 원장 값과 대조한다.
///         저장하지 않는 것: 홀더 DID, 검증기관 DID, nonce, VP/VC 원문, 청구 항목, salt.
contract ReceiptAnchor {
    uint8 public constant KIND_CONSENT = 1; // 동의 영수증 (발급 시, issuer 가 앵커)
    uint8 public constant KIND_PRESENTATION = 2; // 제출 영수증 (검증 시, verifier 가 앵커)

    mapping(bytes32 => uint256) private _anchoredAt; // saltedHash => block.timestamp (0 = 미앵커)

    event Anchored(bytes32 indexed saltedHash, uint8 kind, address indexed by, uint256 ts);

    /// @notice 누구나 호출 가능(해시만 올라가므로 권한 불필요). 같은 해시는 한 번만 앵커된다.
    function anchor(bytes32 saltedHash, uint8 kind) external {
        require(kind == KIND_CONSENT || kind == KIND_PRESENTATION, "BAD_KIND");
        require(saltedHash != bytes32(0), "EMPTY_HASH");
        require(_anchoredAt[saltedHash] == 0, "ALREADY_ANCHORED");

        _anchoredAt[saltedHash] = block.timestamp;
        emit Anchored(saltedHash, kind, msg.sender, block.timestamp);
    }

    /// @return 앵커 시각(unix 초). 앵커된 적 없으면 0.
    function anchoredAt(bytes32 saltedHash) external view returns (uint256) {
        return _anchoredAt[saltedHash];
    }
}
