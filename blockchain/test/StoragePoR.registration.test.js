const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("StoragePoR provider registration lifecycle", function () {
  async function deployContract() {
    const StoragePoR = await ethers.getContractFactory("StoragePoR");
    return StoragePoR.deploy();
  }

  it("rejects a second registration while the provider is active", async function () {
    const [, provider] = await ethers.getSigners();
    const por = await deployContract();
    const collateral = ethers.parseEther("1");

    await por.connect(provider).registerProvider(collateral, { value: collateral });

    await expect(
      por.connect(provider).registerProvider(ethers.parseEther("2"), {
        value: ethers.parseEther("2"),
      })
    ).to.be.revertedWith("Provider already active");

    const status = await por.providers(provider.address);
    expect(status.active).to.equal(true);
    expect(status.lockedCollateral).to.equal(collateral);
  });

  it("rejects a provider from re-registering after a slash", async function () {
    const [, provider] = await ethers.getSigners();
    const por = await deployContract();
    const collateral = ethers.parseEther("1");
    const committedRoot = ethers.keccak256(ethers.toUtf8Bytes("committed-root"));
    const invalidLeaf = ethers.keccak256(ethers.toUtf8Bytes("invalid-leaf"));

    await por.connect(provider).registerProvider(collateral, { value: collateral });
    await por.connect(provider).commitDataRoot(committedRoot);

    await por.verifyStorageProof(provider.address, 1, invalidLeaf, []);

    const status = await por.providers(provider.address);
    expect(status.active).to.equal(false);
    expect(status.lockedCollateral).to.equal(0);
    expect(await por.slashedProviders(provider.address)).to.equal(true);

    await expect(
      por.connect(provider).registerProvider(collateral, { value: collateral })
    ).to.be.revertedWith("Provider permanently slashed");
  });
});
