import assert from "node:assert/strict";
import hre from "hardhat";
const { ethers } = hre;

async function assertRejectsWith(promise, message) {
  await assert.rejects(promise, error => error.message.includes(message));
}

describe("IdentityWallet credential scoping", function () {
  async function deployWallet() {
    const [owner, alice, bob] = await ethers.getSigners();
    const IdentityWallet = await ethers.getContractFactory("IdentityWallet");
    const wallet = await IdentityWallet.deploy();
    await wallet.waitForDeployment();
    return { wallet, owner, alice, bob };
  }

  async function createWallet(wallet, signer) {
    const did = `did:example:${signer.address.toLowerCase()}`;
    const tx = await wallet.connect(signer).createWallet(did);
    await tx.wait();
    return did;
  }

  async function createIssuerSignature(credentialId, recipient, issuer) {
    const messageHash = ethers.solidityPackedKeccak256(
      ["bytes32", "address"],
      [credentialId, recipient]
    );
    return issuer.signMessage(ethers.getBytes(messageHash));
  }

  const credentialId = ethers.keccak256(ethers.toUtf8Bytes("KYCCredential#12345"));

  it("lets the same credentialId be stored in two different wallets", async function () {
    const { wallet, owner, alice, bob } = await deployWallet();
    await createWallet(wallet, alice);
    await createWallet(wallet, bob);

    const aliceSignature = await createIssuerSignature(credentialId, alice.address, owner);
    const bobSignature = await createIssuerSignature(credentialId, bob.address, owner);
    await (await wallet.connect(alice).addCredential(credentialId, aliceSignature)).wait();
    await (await wallet.connect(bob).addCredential(credentialId, bobSignature)).wait();

    assert.equal(await wallet.hasCredential(alice.address, credentialId), true);
    assert.equal(await wallet.hasCredential(bob.address, credentialId), true);
  });

  it("still reverts when the same wallet tries to add a credential twice", async function () {
    const { wallet, owner, alice } = await deployWallet();
    await createWallet(wallet, alice);

    const signature = await createIssuerSignature(credentialId, alice.address, owner);
    await (await wallet.connect(alice).addCredential(credentialId, signature)).wait();

    await assertRejectsWith(
      wallet.connect(alice).addCredential(credentialId, signature),
      "Credential already in wallet"
    );
  });

  it("removeCredential only clears the caller's own wallet, not other wallets holding the same credential", async function () {
    const { wallet, owner, alice, bob } = await deployWallet();
    await createWallet(wallet, alice);
    await createWallet(wallet, bob);
    const aliceSignature = await createIssuerSignature(credentialId, alice.address, owner);
    const bobSignature = await createIssuerSignature(credentialId, bob.address, owner);
    await (await wallet.connect(alice).addCredential(credentialId, aliceSignature)).wait();
    await (await wallet.connect(bob).addCredential(credentialId, bobSignature)).wait();

    await (await wallet.connect(alice).removeCredential(credentialId)).wait();

    assert.equal(await wallet.hasCredential(alice.address, credentialId), false);
    assert.equal(await wallet.hasCredential(bob.address, credentialId), true);

    const bobCredentials = await wallet.getCredentials(bob.address);
    assert.equal(bobCredentials.length, 1);
    assert.equal(bobCredentials[0], credentialId);
  });

  it("hasCredential returns the per-owner answer and ignores nothing", async function () {
    const { wallet, owner, alice, bob } = await deployWallet();
    await createWallet(wallet, alice);
    await createWallet(wallet, bob);

    const signature = await createIssuerSignature(credentialId, alice.address, owner);
    await (await wallet.connect(alice).addCredential(credentialId, signature)).wait();

    assert.equal(await wallet.hasCredential(alice.address, credentialId), true);
    assert.equal(await wallet.hasCredential(bob.address, credentialId), false);
  });

  it("removeCredential reverts for a caller that does not hold the credential", async function () {
    const { wallet, owner, alice, bob } = await deployWallet();
    await createWallet(wallet, alice);
    await createWallet(wallet, bob);
    const signature = await createIssuerSignature(credentialId, alice.address, owner);
    await (await wallet.connect(alice).addCredential(credentialId, signature)).wait();

    await assertRejectsWith(
      wallet.connect(bob).removeCredential(credentialId),
      "Credential not in wallet"
    );
  });

  it("keeps the wallet credentials array consistent across add/remove", async function () {
    const { wallet, owner, alice } = await deployWallet();
    await createWallet(wallet, alice);

    const second = ethers.keccak256(ethers.toUtf8Bytes("DrivingLicence#67890"));
    const credentialSignature = await createIssuerSignature(credentialId, alice.address, owner);
    const secondSignature = await createIssuerSignature(second, alice.address, owner);
    await (await wallet.connect(alice).addCredential(credentialId, credentialSignature)).wait();
    await (await wallet.connect(alice).addCredential(second, secondSignature)).wait();

    assert.deepEqual([...await wallet.getCredentials(alice.address)], [credentialId, second]);

    await (await wallet.connect(alice).removeCredential(credentialId)).wait();

    assert.deepEqual([...await wallet.getCredentials(alice.address)], [second]);
    assert.equal(await wallet.hasCredential(alice.address, second), true);
    assert.equal(await wallet.hasCredential(alice.address, credentialId), false);
  });
});
