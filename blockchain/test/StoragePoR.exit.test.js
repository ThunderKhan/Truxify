const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("StoragePoR collateral exit", function () {
  async function deployContract() {
    const StoragePoR = await ethers.getContractFactory("StoragePoR");
    return StoragePoR.deploy();
  }

  async function advancePastUnbondingPeriod(providerContract) {
    const period = await providerContract.UNBONDING_PERIOD();
    await ethers.provider.send("evm_increaseTime", [Number(period)]);
    await ethers.provider.send("evm_mine");
  }

  it("keeps a provider active during unbonding and returns collateral after the period", async function () {
    const [, provider] = await ethers.getSigners();
    const por = await deployContract();
    const collateral = ethers.parseEther("1");
    const root = ethers.keccak256(ethers.toUtf8Bytes("root"));

    await por.connect(provider).registerProvider(collateral, { value: collateral });
    await por.connect(provider).commitDataRoot(root);
    await por.connect(provider).requestExit();

    expect(await por.exitRequestedAt(provider.address)).to.be.greaterThan(0);
    expect((await por.providers(provider.address)).active).to.equal(true);

    await expect(por.connect(provider).commitDataRoot(root))
      .to.be.revertedWith("Exit already requested");

    await expect(por.connect(provider).withdrawCollateral())
      .to.be.revertedWith("Unbonding period active");

    await advancePastUnbondingPeriod(por);
    await por.connect(provider).withdrawCollateral();

    const status = await por.providers(provider.address);
    expect(status.active).to.equal(false);
    expect(status.lockedCollateral).to.equal(0);
    expect(await por.exitRequestedAt(provider.address)).to.equal(0);
    expect(await ethers.provider.getBalance(await por.getAddress())).to.equal(0);
  });

  it("keeps the collateral slashable during unbonding", async function () {
    const [, provider] = await ethers.getSigners();
    const por = await deployContract();
    const collateral = ethers.parseEther("1");
    const committedRoot = ethers.keccak256(ethers.toUtf8Bytes("committed-root"));
    const invalidLeaf = ethers.keccak256(ethers.toUtf8Bytes("invalid-leaf"));

    await por.connect(provider).registerProvider(collateral, { value: collateral });
    await por.connect(provider).commitDataRoot(committedRoot);
    await por.connect(provider).requestExit();

    await por.verifyStorageProof(provider.address, 1, invalidLeaf, []);

    const status = await por.providers(provider.address);
    expect(status.active).to.equal(false);
    expect(status.lockedCollateral).to.equal(0);
    expect(await por.exitRequestedAt(provider.address)).to.equal(0);

    await expect(por.connect(provider).withdrawCollateral())
      .to.be.revertedWith("Provider not active");
  });
});
