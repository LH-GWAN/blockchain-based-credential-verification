// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IssuerRegistry} from "./IssuerRegistry.sol";

/// @title StatusListRegistry — W3C Bitstring Status List 앵커
/// @notice 온체인에 저장하는 것: listId 별로 gzip+base64url 인코딩된 비트열(최소 131,072비트),
///         단조 증가 버전, 갱신 시각, 소유자(발급기관 컨트롤러) 주소.
///         비트열의 각 비트는 "어떤 증명서 인덱스가 폐기됐는가" 만 나타내며, 인덱스는 발급기관이
///         무작위로 배정하고 목록 전체를 한 번에 내려받으므로 특정 시민을 조회 패턴으로 역추적할 수 없다.
///         저장하지 않는 것: 증명서 원문, 홀더 DID, 인덱스↔시민 매핑, 폐기 사유.
/// @dev 첫 게시자는 활성 발급기관이어야 하며 listId 의 소유자가 된다. 이후 게시는 소유자만,
///      version 은 저장된 값보다 반드시 커야 한다(첫 게시는 version ≥ 1).
contract StatusListRegistry {
    struct StatusList {
        bytes encodedList; // gzip → base64url 문자열의 바이트
        uint64 version;
        uint64 updatedAt;
        address owner;
    }

    IssuerRegistry public immutable issuerRegistry;

    mapping(bytes32 => StatusList) private _lists; // keccak256(listId) => StatusList

    event StatusListPublished(string listId, uint64 version, address owner);

    constructor(IssuerRegistry issuerRegistry_) {
        require(address(issuerRegistry_) != address(0), "ZERO_REGISTRY");
        issuerRegistry = issuerRegistry_;
    }

    function publish(string calldata listId, bytes calldata encodedList, uint64 version) external {
        require(bytes(listId).length != 0, "EMPTY_ID");
        require(encodedList.length != 0, "EMPTY_LIST");
        StatusList storage list = _lists[_key(listId)];

        if (list.owner == address(0)) {
            // 최초 게시: 활성 발급기관만 가능, 게시자가 소유자가 된다
            require(issuerRegistry.isActiveController(msg.sender), "NOT_ACTIVE_ISSUER");
            list.owner = msg.sender;
        } else {
            require(msg.sender == list.owner, "NOT_LIST_OWNER");
        }
        require(version > list.version, "VERSION_NOT_INCREASING");

        list.encodedList = encodedList;
        list.version = version;
        list.updatedAt = uint64(block.timestamp);

        emit StatusListPublished(listId, version, msg.sender);
    }

    /// @notice 미게시 listId 면 revert(LIST_UNKNOWN).
    function get(string calldata listId)
        external
        view
        returns (bytes memory encodedList, uint64 version, uint64 updatedAt, address owner)
    {
        StatusList storage list = _lists[_key(listId)];
        require(list.owner != address(0), "LIST_UNKNOWN");
        return (list.encodedList, list.version, list.updatedAt, list.owner);
    }

    function _key(string calldata listId) private pure returns (bytes32) {
        return keccak256(bytes(listId));
    }
}
