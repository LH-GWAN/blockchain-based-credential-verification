// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IssuerRegistry — 발급기관 공개키(DID 문서) 레지스트리
/// @notice 온체인에 저장하는 것: 발급기관 DID(`did:dbp:<id>`), VC 서명용 Ed25519 공개키(32바이트),
///         기관명, 체인 트랜잭션용 컨트롤러 EVM 주소, 활성 여부, 등록 시각 — 즉 "기관" 정보뿐이다.
///         저장하지 않는 것: 시민 개인정보 일체(이름·주민번호·주소·소득·장애·계좌·VC 원문·AI 상담 내용).
///         `resolveDid()` 는 이 데이터로 DID Document 를 생성하며, 실서비스에서는 did:web/did:ethr 로 교체 가능하다.
/// @dev 거버넌스 주소 = 배포 키("대구시 거버넌스"). 실서비스는 다중서명으로 교체한다.
contract IssuerRegistry {
    struct Issuer {
        string did;
        bytes32 ed25519PubKey; // VC 서명 검증용 (EVM 키와 다름)
        string name;
        address controller; // RuleRegistry / StatusListRegistry 에 트랜잭션을 보내는 EVM 주소
        bool active;
        uint64 registeredAt;
    }

    address public governance;

    mapping(bytes32 => Issuer) private _issuers; // keccak256(did) => Issuer
    mapping(address => bytes32) private _didKeyOfController; // controller => keccak256(did)

    event IssuerRegistered(string did, bytes32 pubKey, string name, address controller);
    event IssuerStatusChanged(string did, bool active);
    event IssuerKeyRotated(string did, bytes32 newKey);
    event GovernanceTransferred(address indexed previousGovernance, address indexed newGovernance);

    modifier onlyGovernance() {
        require(msg.sender == governance, "NOT_GOVERNANCE");
        _;
    }

    constructor() {
        governance = msg.sender;
        emit GovernanceTransferred(address(0), msg.sender);
    }

    /// @notice 발급기관 등록. did 중복 또는 controller 중복 바인딩이면 revert.
    function register(
        string calldata did,
        bytes32 ed25519PubKey,
        string calldata name,
        address controller
    ) external onlyGovernance {
        require(bytes(did).length != 0, "EMPTY_DID");
        require(ed25519PubKey != bytes32(0), "EMPTY_KEY");
        require(controller != address(0), "ZERO_CONTROLLER");
        bytes32 key = _key(did);
        require(_issuers[key].registeredAt == 0, "ISSUER_EXISTS");
        require(_didKeyOfController[controller] == bytes32(0), "CONTROLLER_BOUND");

        _issuers[key] = Issuer({
            did: did,
            ed25519PubKey: ed25519PubKey,
            name: name,
            controller: controller,
            active: true,
            registeredAt: uint64(block.timestamp)
        });
        _didKeyOfController[controller] = key;

        emit IssuerRegistered(did, ed25519PubKey, name, controller);
    }

    /// @notice 활성/정지 전환. 정지된 기관의 VC 는 검증기관이 거부한다(ISSUER_INACTIVE).
    function setActive(string calldata did, bool active) external onlyGovernance {
        Issuer storage issuer = _mustGet(did);
        issuer.active = active;
        emit IssuerStatusChanged(did, active);
    }

    /// @notice Ed25519 서명키 교체(키 로테이션).
    function rotateKey(string calldata did, bytes32 newKey) external onlyGovernance {
        require(newKey != bytes32(0), "EMPTY_KEY");
        Issuer storage issuer = _mustGet(did);
        issuer.ed25519PubKey = newKey;
        emit IssuerKeyRotated(did, newKey);
    }

    function transferGovernance(address newGovernance) external onlyGovernance {
        require(newGovernance != address(0), "ZERO_GOVERNANCE");
        emit GovernanceTransferred(governance, newGovernance);
        governance = newGovernance;
    }

    // ---------------------------------------------------------------- views

    /// @notice 미등록 did 면 revert(ISSUER_UNKNOWN).
    function get(string calldata did) external view returns (Issuer memory) {
        return _mustGet(did);
    }

    function exists(string calldata did) external view returns (bool) {
        return _issuers[_key(did)].registeredAt != 0;
    }

    /// @notice 해당 주소가 "활성" 발급기관의 컨트롤러인지. RuleRegistry/StatusListRegistry 의 권한 검사에 사용.
    function isActiveController(address controller) external view returns (bool) {
        bytes32 key = _didKeyOfController[controller];
        return key != bytes32(0) && _issuers[key].active;
    }

    /// @notice 컨트롤러 주소에 바인딩된 did. 미바인딩이면 빈 문자열.
    function controllerDid(address controller) external view returns (string memory) {
        bytes32 key = _didKeyOfController[controller];
        if (key == bytes32(0)) return "";
        return _issuers[key].did;
    }

    // ------------------------------------------------------------- internal

    function _key(string calldata did) private pure returns (bytes32) {
        return keccak256(bytes(did));
    }

    function _mustGet(string calldata did) private view returns (Issuer storage issuer) {
        issuer = _issuers[_key(did)];
        require(issuer.registeredAt != 0, "ISSUER_UNKNOWN");
    }
}
