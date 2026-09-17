// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title FreightAMM
 * @dev Constant Product (x * y = k) Automated Market Maker (AMM) Liquidity Pool swap contract.
 */
contract FreightAMM is Ownable, ReentrancyGuard {

    IERC20 public creditToken;
    IERC20 public stablecoinToken;

    uint256 public reserveCredit;
    uint256 public reserveStable;

    uint256 public swapFeeBps = 30;

    event Swapped(address indexed user, uint256 amountIn, uint256 amountOut, bool isCreditToStable);
    event LiquidityAdded(address indexed provider, uint256 creditAmount, uint256 stableAmount);
    event SwapFeeUpdated(uint256 swapFeeBps);

    constructor(address _creditAddress, address _stableAddress) Ownable(msg.sender) {
        creditToken = IERC20(_creditAddress);
        stablecoinToken = IERC20(_stableAddress);
    }

    /**
     * @dev Simple constant product swap execution: (x + dx)(y - dy) = k
     */
    function swap(uint256 _amountIn, bool _isCreditToStable, uint256 _minAmountOut)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        require(_amountIn > 0, "Swap amount must be > 0");
        require(reserveCredit > 0 && reserveStable > 0, "Pool not seeded");

        uint256 amountInReceived;

        if (_isCreditToStable) {
            amountInReceived = _transferIn(creditToken, _amountIn);

            uint256 feeAmount = (amountInReceived * swapFeeBps) / 10000;
            uint256 amountInNet = amountInReceived - feeAmount;

            // Constant product equation evaluation: dy = (y * dx) / (x + dx)
            amountOut = (reserveStable * amountInNet) / (reserveCredit + amountInReceived);
            require(amountOut >= _minAmountOut, "Swap output below minAmountOut");

            reserveCredit += amountInReceived;
            reserveStable -= amountOut;

            require(stablecoinToken.transfer(msg.sender, amountOut), "Payout transfer failed");
        } else {
            amountInReceived = _transferIn(stablecoinToken, _amountIn);

            uint256 feeAmount = (amountInReceived * swapFeeBps) / 10000;
            uint256 amountInNet = amountInReceived - feeAmount;

            amountOut = (reserveCredit * amountInNet) / (reserveStable + amountInReceived);
            require(amountOut >= _minAmountOut, "Swap output below minAmountOut");

            reserveStable += amountInReceived;
            reserveCredit -= amountOut;

            require(creditToken.transfer(msg.sender, amountOut), "Payout transfer failed");
        }

        emit Swapped(msg.sender, _amountIn, amountOut, _isCreditToStable);
    }

    function setSwapFeeBps(uint256 _swapFeeBps) external onlyOwner {
        require(_swapFeeBps <= 10000, "Swap fee exceeds 100%");
        swapFeeBps = _swapFeeBps;
        emit SwapFeeUpdated(_swapFeeBps);
    }

    function addLiquidity(uint256 _creditAmount, uint256 _stableAmount) external onlyOwner {
        uint256 creditReceived = _transferIn(creditToken, _creditAmount);
        uint256 stableReceived = _transferIn(stablecoinToken, _stableAmount);

        reserveCredit += creditReceived;
        reserveStable += stableReceived;

        emit LiquidityAdded(msg.sender, creditReceived, stableReceived);
    }

    function _transferIn(IERC20 token, uint256 amount) internal returns (uint256 received) {
        uint256 balanceBefore = token.balanceOf(address(this));
        require(token.transferFrom(msg.sender, address(this), amount), "Transfer failed");
        uint256 balanceAfter = token.balanceOf(address(this));
        require(balanceAfter >= balanceBefore, "Token balance decreased");

        received = balanceAfter - balanceBefore;
        require(received > 0, "No tokens received");
    }
}
