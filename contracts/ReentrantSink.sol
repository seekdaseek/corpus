// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface ICorpusVault {
    function createVault(bytes32, string calldata, uint256, uint64) external returns (uint256);
    function withdraw() external;
}

/// @notice Test-only malicious creator: attempts to re-enter withdraw() from receive().
contract ReentrantSink {
    ICorpusVault public vault;
    bool public attack;

    constructor(address vault_) { vault = ICorpusVault(vault_); }

    function create(bytes32 h, string calldata uri, uint256 price, uint64 dur) external returns (uint256) {
        return vault.createVault(h, uri, price, dur);
    }

    function setAttack(bool a) external { attack = a; }

    function pull() external { vault.withdraw(); }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    receive() external payable {
        if (attack) {
            vault.withdraw(); // must revert via ReentrancyGuard
        }
    }
}
