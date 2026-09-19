// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/interfaces/IERC1271.sol";

contract MockERC1271Wallet is IERC1271 {
    bytes4 public constant MAGICVALUE = IERC1271.isValidSignature.selector;

    address public immutable signer;
    mapping(bytes32 => bool) public approvedDigests;

    constructor(address _signer) {
        require(_signer != address(0), "Invalid signer");
        signer = _signer;
    }

    function approveDigest(bytes32 digest) external {
        require(msg.sender == signer, "Not signer");
        approvedDigests[digest] = true;
    }

    function execute(address target, bytes calldata data) external returns (bytes memory result) {
        require(msg.sender == signer, "Not signer");
        (bool success, bytes memory returndata) = target.call(data);
        require(success, "Execution failed");
        return returndata;
    }

    function isValidSignature(
        bytes32 hash,
        bytes memory
    ) external view returns (bytes4) {
        return approvedDigests[hash] ? MAGICVALUE : bytes4(0xffffffff);
    }
}
