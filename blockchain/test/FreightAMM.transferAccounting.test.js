const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("FreightAMM transfer accounting", function () {
  it("tracks the actual amount received from a fee-on-transfer token", async function () {
    const [owner, swapper] = await ethers.getSigners();

    const FeeOnTransferToken = await ethers.getContractFactory("FeeOnTransferToken");
    const creditToken = await FeeOnTransferToken.deploy(100);

    const DAOToken = await ethers.getContractFactory("DAOToken");
    const stablecoinToken = await DAOToken.deploy();

    const FreightAMM = await ethers.getContractFactory("FreightAMM");
    const amm = await FreightAMM.deploy(
      await creditToken.getAddress(),
      await stablecoinToken.getAddress()
    );

    await creditToken.approve(await amm.getAddress(), 1000);
    await stablecoinToken.approve(await amm.getAddress(), 1000);
    await amm.addLiquidity(1000, 1000);

    expect(await creditToken.balanceOf(await amm.getAddress())).to.equal(990);
    expect(await amm.reserveCredit()).to.equal(990);
    expect(await stablecoinToken.balanceOf(await amm.getAddress())).to.equal(1000);
    expect(await amm.reserveStable()).to.equal(1000);

    await creditToken.mint(swapper.address, 100);
    await creditToken.connect(swapper).approve(await amm.getAddress(), 100);

    await amm.connect(swapper).swap(100, true, 0);

    expect(await creditToken.balanceOf(await amm.getAddress())).to.equal(1089);
    expect(await amm.reserveCredit()).to.equal(1089);
    expect(await creditToken.balanceOf(await amm.getAddress())).to.equal(
      await amm.reserveCredit()
    );
    expect(await stablecoinToken.balanceOf(await amm.getAddress())).to.equal(
      await amm.reserveStable()
    );
  });
});
