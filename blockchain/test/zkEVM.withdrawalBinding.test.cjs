const { expect } = require("chai");
const { ethers } = require("hardhat");

function encodeProof(recipient, amount) {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256[2]", "uint256[2][2]", "uint256[2]", "uint256[2]"],
    [
      [1n, 2n],
      [
        [3n, 4n],
        [5n, 6n],
      ],
      [7n, 8n],
      [BigInt(recipient), amount],
    ]
  );
}

describe("zkEVM withdrawal proof binding", function () {
  async function deployFixture() {
    const [owner, withdrawer, otherUser] = await ethers.getSigners();
    const Verifier = await ethers.getContractFactory("zkEVMTestVerifier");
    const verifier = await Verifier.deploy();

    const ZkEVM = await ethers.getContractFactory("zkEVM");
    const zkEVM = await ZkEVM.deploy(await verifier.getAddress());

    return { owner, withdrawer, otherUser, zkEVM };
  }

  it("rejects a valid proof when the withdrawal amount is changed", async function () {
    const { withdrawer, zkEVM } = await deployFixture();
    const depositedAmount = ethers.parseEther("2");
    const provedAmount = ethers.parseEther("1");
    const requestedAmount = ethers.parseEther("1.5");

    await zkEVM.connect(withdrawer).depositToL2({ value: depositedAmount });

    const proof = encodeProof(withdrawer.address, provedAmount);

    await expect(
      zkEVM.connect(withdrawer).withdrawFromL2(requestedAmount, proof)
    ).to.be.revertedWith("Proof amount mismatch");

    expect(await zkEVM.getBalance(withdrawer.address)).to.equal(depositedAmount);
  });

  it("rejects a proof generated for a different recipient", async function () {
    const { withdrawer, otherUser, zkEVM } = await deployFixture();
    const amount = ethers.parseEther("1");

    await zkEVM.connect(otherUser).depositToL2({ value: amount });

    const proof = encodeProof(withdrawer.address, amount);

    await expect(
      zkEVM.connect(otherUser).withdrawFromL2(amount, proof)
    ).to.be.revertedWith("Proof recipient mismatch");

    expect(await zkEVM.getBalance(otherUser.address)).to.equal(amount);
  });

  it("allows a withdrawal when proof recipient and amount match the call", async function () {
    const { withdrawer, zkEVM } = await deployFixture();
    const amount = ethers.parseEther("1");

    await zkEVM.connect(withdrawer).depositToL2({ value: amount });

    const proof = encodeProof(withdrawer.address, amount);
    await expect(
      zkEVM.connect(withdrawer).withdrawFromL2(amount, proof)
    ).to.emit(zkEVM, "BridgeWithdraw")
      .withArgs(withdrawer.address, amount);

    expect(await zkEVM.getBalance(withdrawer.address)).to.equal(0n);
  });
  it("rejects replay across direct and bridge withdrawal paths", async function () {
    const { owner, withdrawer, zkEVM } = await deployFixture();
    const Bridge = await ethers.getContractFactory("zkEVMBridge");
    const bridge = await Bridge.deploy(await zkEVM.getAddress());
    await bridge.waitForDeployment();

    await zkEVM.connect(owner).setBridge(await bridge.getAddress());
    await bridge.connect(owner).setBridgeFee(0);

    const depositAmount = ethers.parseEther("4");
    const withdrawalAmount = ethers.parseEther("1");
    await bridge.connect(withdrawer).depositToL2({ value: depositAmount });

    const proof = encodeProof(withdrawer.address, withdrawalAmount);

    await zkEVM
      .connect(withdrawer)
      .withdrawFromL2(withdrawalAmount, proof);

    await expect(
      bridge.connect(withdrawer).withdrawFromL2(withdrawalAmount, proof)
    ).to.be.revertedWith("Proof already used");

    const secondProof = encodeProof(withdrawer.address, withdrawalAmount + 1n);
    await expect(
      bridge.connect(withdrawer).withdrawFromL2(withdrawalAmount + 1n, secondProof)
    ).to.emit(bridge, "BridgeWithdraw")
      .withArgs(withdrawer.address, withdrawalAmount + 1n);

    await expect(
      zkEVM
        .connect(withdrawer)
        .withdrawFromL2(withdrawalAmount + 1n, secondProof)
    ).to.be.revertedWith("Proof already used");
  });

  it("rejects replay of a successful proof after the balance is replenished", async function () {
    const { withdrawer, zkEVM } = await deployFixture();
    const amount = ethers.parseEther("1");

    await zkEVM.connect(withdrawer).depositToL2({ value: ethers.parseEther("2") });

    const proof = encodeProof(withdrawer.address, amount);
    await zkEVM.connect(withdrawer).withdrawFromL2(amount, proof);

    await zkEVM.connect(withdrawer).depositToL2({ value: amount });

    await expect(
      zkEVM.connect(withdrawer).withdrawFromL2(amount, proof)
    ).to.be.revertedWith("Proof already used");

    expect(await zkEVM.getBalance(withdrawer.address)).to.equal(amount);
  });

});