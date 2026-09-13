// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IssuerRegistry} from "./IssuerRegistry.sol";

/// @title RuleRegistry — 규칙 번들·스키마 버전 해시 레지스트리 (버전당 1회, 불변)
/// @notice 온체인에 저장하는 것: (번들 이름, 버전) 별 규칙 번들 해시와 VC 스키마 해시(각 32바이트),
///         등록한 발급기관 컨트롤러 주소, 등록 시각. 지갑의 사전 판정과 발급기관의 최종 판정이
///         "같은 규칙 버전" 임을 검증기관이 원장에서 대조하기 위한 앵커이다.
///         저장하지 않는 것: 규칙 본문, 정책 문서, 시민 데이터, 판정 결과·입력값.
contract RuleRegistry {
    struct Bundle {
        bytes32 bundleHash;
        bytes32 schemaHash;
        address by;
        uint64 at;
    }

    IssuerRegistry public immutable issuerRegistry;

    mapping(bytes32 => Bundle) private _bundles; // keccak256(abi.encode(bundle, version)) => Bundle

    event BundleRegistered(string bundle, string version, bytes32 bundleHash, bytes32 schemaHash, address by);

    constructor(IssuerRegistry issuerRegistry_) {
        require(address(issuerRegistry_) != address(0), "ZERO_REGISTRY");
        issuerRegistry = issuerRegistry_;
    }

    /// @notice 활성 발급기관 컨트롤러만 호출 가능. 같은 (bundle, version) 은 한 번만 등록된다.
    function registerBundle(
        string calldata bundle,
        string calldata version,
        bytes32 bundleHash,
        bytes32 schemaHash
    ) external {
        require(issuerRegistry.isActiveController(msg.sender), "NOT_ACTIVE_ISSUER");
        require(bytes(bundle).length != 0 && bytes(version).length != 0, "EMPTY_ID");
        require(bundleHash != bytes32(0), "EMPTY_HASH");
        bytes32 key = _key(bundle, version);
        require(_bundles[key].at == 0, "BUNDLE_EXISTS");

        _bundles[key] = Bundle({bundleHash: bundleHash, schemaHash: schemaHash, by: msg.sender, at: uint64(block.timestamp)});
        emit BundleRegistered(bundle, version, bundleHash, schemaHash, msg.sender);
    }

    /// @notice 미등록이면 revert(BUNDLE_UNKNOWN).
    function getBundle(string calldata bundle, string calldata version)
        external
        view
        returns (bytes32 bundleHash, bytes32 schemaHash, address by, uint64 at)
    {
        Bundle storage b = _bundles[_key(bundle, version)];
        require(b.at != 0, "BUNDLE_UNKNOWN");
        return (b.bundleHash, b.schemaHash, b.by, b.at);
    }

    function hasBundle(string calldata bundle, string calldata version) external view returns (bool) {
        return _bundles[_key(bundle, version)].at != 0;
    }

    function _key(string calldata bundle, string calldata version) private pure returns (bytes32) {
        return keccak256(abi.encode(bundle, version));
    }
}
