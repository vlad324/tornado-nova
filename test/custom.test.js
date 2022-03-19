const hre = require('hardhat')
const { ethers, waffle } = hre
const { loadFixture } = waffle
const { expect } = require('chai')
const { utils } = ethers

const Utxo = require('../src/utxo')
const { transaction, prepareTransaction } = require('../src/index')
const { poseidonHash } = require('../src/utils')
const { Keypair } = require('../src/keypair')
const { encodeDataForBridge } = require('./utils')

const MERKLE_TREE_HEIGHT = 5
const l1ChainId = 1
const MINIMUM_WITHDRAWAL_AMOUNT = utils.parseEther('0.05')
const MAXIMUM_DEPOSIT_AMOUNT = utils.parseEther('1')

describe('TornadoPool custom', function () {
  this.timeout(20000)

  async function deploy(contractName, ...args) {
    const Factory = await ethers.getContractFactory(contractName)
    const instance = await Factory.deploy(...args)
    return instance.deployed()
  }

  async function fixture() {
    require('../scripts/compileHasher')
    const [sender, gov, l1Unwrapper, multisig] = await ethers.getSigners()
    const verifier2 = await deploy('Verifier2')
    const verifier16 = await deploy('Verifier16')
    const hasher = await deploy('Hasher')

    const token = await deploy('PermittableToken', 'Wrapped ETH', 'WETH', 18, l1ChainId)
    await token.mint(sender.address, utils.parseEther('10000'))

    const amb = await deploy('MockAMB', gov.address, l1ChainId)
    const omniBridge = await deploy('MockOmniBridge', amb.address)

    /** @type {TornadoPool} */
    const tornadoPoolImpl = await deploy(
      'TornadoPool',
      verifier2.address,
      verifier16.address,
      MERKLE_TREE_HEIGHT,
      hasher.address,
      token.address,
      omniBridge.address,
      l1Unwrapper.address,
      gov.address,
      l1ChainId,
      multisig.address,
    )

    const { data } = await tornadoPoolImpl.populateTransaction.initialize(
      MINIMUM_WITHDRAWAL_AMOUNT,
      MAXIMUM_DEPOSIT_AMOUNT,
    )
    const proxy = await deploy(
      'CrossChainUpgradeableProxy',
      tornadoPoolImpl.address,
      gov.address,
      data,
      amb.address,
      l1ChainId,
    )

    const tornadoPool = tornadoPoolImpl.attach(proxy.address)

    await token.approve(tornadoPool.address, utils.parseEther('10000'))

    const merkleTreeWithHistory = await deploy(
      'MerkleTreeWithHistoryMock',
      MERKLE_TREE_HEIGHT,
      hasher.address,
    )

    return { tornadoPool, token, omniBridge, merkleTreeWithHistory }
  }

  it('should deposit to L1 and withdraw to L2', async () => {
    const { tornadoPool, token, omniBridge, merkleTreeWithHistory } = await loadFixture(fixture)

    // estimate gas for insert into tree
    const gasEstimation = await merkleTreeWithHistory.estimateGas.insert(
      poseidonHash(['1']),
      poseidonHash(['2']),
    )
    console.log('Insert gas estimation = ' + gasEstimation)

    // generate keypair
    const userKeypair = new Keypair()

    // user deposits into tornado pool
    const depositAmount = utils.parseEther('0.08')
    const depositUtxo = new Utxo({ amount: depositAmount, keypair: userKeypair })
    const { args, extData } = await prepareTransaction({
      tornadoPool,
      outputs: [depositUtxo],
    })

    const onTokenBridgedData = encodeDataForBridge({
      proof: args,
      extData,
    })
    const onTokenBridgedTx = await tornadoPool.populateTransaction.onTokenBridged(
      token.address,
      depositUtxo.amount,
      onTokenBridgedData,
    )
    // emulating bridge. first it sends tokens to omnibridge mock then it sends to the pool
    await token.transfer(omniBridge.address, depositAmount)
    const transferTx = await token.populateTransaction.transfer(tornadoPool.address, depositAmount)

    await omniBridge.execute([
      { who: token.address, callData: transferTx.data }, // send tokens to pool
      { who: tornadoPool.address, callData: onTokenBridgedTx.data }, // call onTokenBridgedTx
    ])

    // check pool balance before withdrawal
    const poolBalanceBefore = await token.balanceOf(tornadoPool.address)

    // withdrawal of funds to L2
    const withdrawAmount = utils.parseEther('0.05')
    const recipient = '0xDeaD00000000000000000000000000000000BEEf'
    const aliceChangeUtxo = new Utxo({
      amount: depositAmount.sub(withdrawAmount),
      keypair: userKeypair,
    })
    await transaction({
      tornadoPool,
      inputs: [depositUtxo],
      outputs: [aliceChangeUtxo],
      recipient: recipient,
      isL1Withdrawal: false,
    })

    // recipient has 0.05 ETH
    const recipientBalance = await token.balanceOf(recipient)
    expect(recipientBalance).to.be.equal(withdrawAmount)

    // bridge has 0 balance
    const omniBridgeBalance = await token.balanceOf(omniBridge.address)
    expect(omniBridgeBalance).to.be.equal(0)

    // pool has poolBalanceBefore - 0.05 ETH
    const poolBalanceAfter = await token.balanceOf(tornadoPool.address)
    expect(poolBalanceAfter).to.be.equal(poolBalanceBefore.sub(withdrawAmount))
  })
})
