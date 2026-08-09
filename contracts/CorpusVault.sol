// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title CorpusVault — tokenized data assets with machine-verified appraisals
/// @notice Each vault is an ERC-721 representing one dataset epoch. An appraiser
///         (automated QA + AI) posts an onchain quality report. Sales are HARD-GATED:
///         no appraisal, or an appraisal in refusal state, means the license cannot
///         be bought. Buyers receive a time-boxed access license; revenue splits
///         between the creator and the protocol treasury using pull payments.
contract CorpusVault is ERC721, AccessControl, ReentrancyGuard {
    bytes32 public constant APPRAISER_ROLE = keccak256("APPRAISER_ROLE");

    struct Vault {
        bytes32 contentHash;     // sha256 of the dataset artifact
        string manifestURI;      // off-chain manifest (schema, coverage, sample)
        address creator;         // original publisher (immutable)
        uint256 priceWei;        // license price in native gas token
        uint64 licenseDuration;  // seconds of access per purchase
        bool listed;             // purchasable flag (owner-controlled)
    }

    struct Appraisal {
        uint16 scoreBps;      // 0-10000 quality score
        bytes32 reportHash;   // sha256 of the full QA report
        string reportURI;     // where the report lives
        uint64 appraisedAt;   // block timestamp of appraisal
        bool refusal;         // true = QA hard-failed; sale blocked
        bool exists;
    }

    uint16 public constant MAX_BPS = 10000;
    uint16 public protocolFeeBps;
    address public treasury;

    uint256 public nextVaultId;
    mapping(uint256 => Vault) public vaults;
    mapping(uint256 => Appraisal) public appraisals;
    mapping(uint256 => mapping(address => uint64)) public licenseExpiry;
    mapping(address => uint256) public balances; // pull-payment credits

    event VaultCreated(uint256 indexed vaultId, address indexed creator, bytes32 contentHash, string manifestURI, uint256 priceWei, uint64 licenseDuration);
    event AppraisalPosted(uint256 indexed vaultId, uint16 scoreBps, bytes32 reportHash, string reportURI, bool refusal);
    event LicensePurchased(uint256 indexed vaultId, address indexed buyer, uint64 expiry, uint256 pricePaid);
    event ListingChanged(uint256 indexed vaultId, bool listed, uint256 priceWei);
    event Withdrawn(address indexed account, uint256 amount);
    event ProtocolFeeChanged(uint16 feeBps);
    event TreasuryChanged(address treasury);

    error NotVaultOwner();
    error NotAppraised();
    error AppraisalRefused();
    error NotListed();
    error WrongPayment(uint256 expected, uint256 sent);
    error ZeroPrice();
    error ZeroDuration();
    error FeeTooHigh();
    error NothingToWithdraw();
    error TransferFailed();

    constructor(address admin, address treasury_, uint16 protocolFeeBps_)
        ERC721("Corpus Data Vault", "CORPUS")
    {
        if (protocolFeeBps_ > 2000) revert FeeTooHigh(); // hard cap 20%
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        treasury = treasury_;
        protocolFeeBps = protocolFeeBps_;
    }

    // ------------------------------------------------------------------
    // Creation & listing
    // ------------------------------------------------------------------

    function createVault(
        bytes32 contentHash,
        string calldata manifestURI,
        uint256 priceWei,
        uint64 licenseDuration
    ) external returns (uint256 vaultId) {
        if (priceWei == 0) revert ZeroPrice();
        if (licenseDuration == 0) revert ZeroDuration();
        vaultId = ++nextVaultId;
        vaults[vaultId] = Vault({
            contentHash: contentHash,
            manifestURI: manifestURI,
            creator: msg.sender,
            priceWei: priceWei,
            licenseDuration: licenseDuration,
            listed: true
        });
        _safeMint(msg.sender, vaultId);
        emit VaultCreated(vaultId, msg.sender, contentHash, manifestURI, priceWei, licenseDuration);
    }

    function setListing(uint256 vaultId, bool listed, uint256 priceWei) external {
        if (ownerOf(vaultId) != msg.sender) revert NotVaultOwner();
        if (priceWei == 0) revert ZeroPrice();
        vaults[vaultId].listed = listed;
        vaults[vaultId].priceWei = priceWei;
        emit ListingChanged(vaultId, listed, priceWei);
    }

    // ------------------------------------------------------------------
    // Appraisal (the trust layer)
    // ------------------------------------------------------------------

    function setAppraisal(
        uint256 vaultId,
        uint16 scoreBps,
        bytes32 reportHash,
        string calldata reportURI,
        bool refusal
    ) external onlyRole(APPRAISER_ROLE) {
        _requireOwned(vaultId); // vault must exist
        appraisals[vaultId] = Appraisal({
            scoreBps: scoreBps > MAX_BPS ? MAX_BPS : scoreBps,
            reportHash: reportHash,
            reportURI: reportURI,
            appraisedAt: uint64(block.timestamp),
            refusal: refusal,
            exists: true
        });
        emit AppraisalPosted(vaultId, scoreBps, reportHash, reportURI, refusal);
    }

    // ------------------------------------------------------------------
    // Purchase (hard-gated by appraisal state)
    // ------------------------------------------------------------------

    function buyLicense(uint256 vaultId) external payable nonReentrant {
        Vault storage v = vaults[vaultId];
        _requireOwned(vaultId);
        if (!v.listed) revert NotListed();
        Appraisal storage a = appraisals[vaultId];
        if (!a.exists) revert NotAppraised();
        if (a.refusal) revert AppraisalRefused();
        if (msg.value != v.priceWei) revert WrongPayment(v.priceWei, msg.value);

        uint256 fee = (msg.value * protocolFeeBps) / MAX_BPS;
        balances[treasury] += fee;
        balances[ownerOf(vaultId)] += msg.value - fee;

        uint64 base = licenseExpiry[vaultId][msg.sender];
        uint64 nowTs = uint64(block.timestamp);
        uint64 start = base > nowTs ? base : nowTs;
        uint64 expiry = start + v.licenseDuration;
        licenseExpiry[vaultId][msg.sender] = expiry;

        emit LicensePurchased(vaultId, msg.sender, expiry, msg.value);
    }

    function hasAccess(uint256 vaultId, address user) external view returns (bool) {
        if (_ownerOf(vaultId) == user) return true;
        return licenseExpiry[vaultId][user] > block.timestamp;
    }

    // ------------------------------------------------------------------
    // Pull payments
    // ------------------------------------------------------------------

    function withdraw() external nonReentrant {
        uint256 amount = balances[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        balances[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    function setProtocolFee(uint16 feeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (feeBps > 2000) revert FeeTooHigh();
        protocolFeeBps = feeBps;
        emit ProtocolFeeChanged(feeBps);
    }

    function setTreasury(address treasury_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        treasury = treasury_;
        emit TreasuryChanged(treasury_);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
