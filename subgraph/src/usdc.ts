import { BigInt, Bytes } from "@graphprotocol/graph-ts"
import { Transfer as TransferEvent } from "../generated/USDC/USDC"
import {
  Account,
  Transfer,
  USDCActivity,
  USDCActivityDay,
  USDCActivityHour
} from "../generated/schema"

const ONE = BigInt.fromI32(1)
const GLOBAL = "global"
const HOUR = BigInt.fromI32(3600)
const DAY = BigInt.fromI32(86400)
const LARGE_TRANSFER = BigInt.fromString("10000000000") // 10,000 USDC
const WHALE_TRANSFER = BigInt.fromString("100000000000") // 100,000 USDC

function account(id: Bytes, event: TransferEvent): Account {
  let entity = Account.load(id)
  if (entity == null) {
    entity = new Account(id)
    entity.sentAmount = BigInt.zero()
    entity.receivedAmount = BigInt.zero()
    entity.transferCount = BigInt.zero()
  }
  entity.lastActiveBlock = event.block.number
  entity.lastActiveTimestamp = event.block.timestamp
  return entity
}

function updateHour(event: TransferEvent): void {
  let timestamp = event.block.timestamp.div(HOUR).times(HOUR)
  let snapshot = USDCActivityHour.load(timestamp.toString())
  if (snapshot == null) {
    snapshot = new USDCActivityHour(timestamp.toString())
    snapshot.timestamp = timestamp
    snapshot.transferCount = BigInt.zero()
    snapshot.volume = BigInt.zero()
    snapshot.maxTransfer = BigInt.zero()
    snapshot.largeTransferCount = BigInt.zero()
    snapshot.whaleTransferCount = BigInt.zero()
    snapshot.whaleVolume = BigInt.zero()
  }
  snapshot.transferCount = snapshot.transferCount.plus(ONE)
  snapshot.volume = snapshot.volume.plus(event.params.value)
  if (event.params.value.gt(snapshot.maxTransfer))
    snapshot.maxTransfer = event.params.value
  if (event.params.value.ge(LARGE_TRANSFER))
    snapshot.largeTransferCount = snapshot.largeTransferCount.plus(ONE)
  if (event.params.value.ge(WHALE_TRANSFER)) {
    snapshot.whaleTransferCount = snapshot.whaleTransferCount.plus(ONE)
    snapshot.whaleVolume = snapshot.whaleVolume.plus(event.params.value)
  }
  snapshot.save()
}

function updateDay(event: TransferEvent): void {
  let timestamp = event.block.timestamp.div(DAY).times(DAY)
  let snapshot = USDCActivityDay.load(timestamp.toString())
  if (snapshot == null) {
    snapshot = new USDCActivityDay(timestamp.toString())
    snapshot.timestamp = timestamp
    snapshot.transferCount = BigInt.zero()
    snapshot.volume = BigInt.zero()
    snapshot.maxTransfer = BigInt.zero()
    snapshot.largeTransferCount = BigInt.zero()
    snapshot.whaleTransferCount = BigInt.zero()
    snapshot.whaleVolume = BigInt.zero()
  }
  snapshot.transferCount = snapshot.transferCount.plus(ONE)
  snapshot.volume = snapshot.volume.plus(event.params.value)
  if (event.params.value.gt(snapshot.maxTransfer))
    snapshot.maxTransfer = event.params.value
  if (event.params.value.ge(LARGE_TRANSFER))
    snapshot.largeTransferCount = snapshot.largeTransferCount.plus(ONE)
  if (event.params.value.ge(WHALE_TRANSFER)) {
    snapshot.whaleTransferCount = snapshot.whaleTransferCount.plus(ONE)
    snapshot.whaleVolume = snapshot.whaleVolume.plus(event.params.value)
  }
  snapshot.save()
}

export function handleTransfer(event: TransferEvent): void {
  let transfer = new Transfer(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  )
  transfer.from = event.params.from
  transfer.to = event.params.to
  transfer.amount = event.params.value
  transfer.blockNumber = event.block.number
  transfer.blockTimestamp = event.block.timestamp
  transfer.transactionHash = event.transaction.hash
  transfer.save()

  let sender = account(event.params.from, event)
  sender.sentAmount = sender.sentAmount.plus(event.params.value)
  sender.transferCount = sender.transferCount.plus(ONE)
  sender.save()

  let receiver = account(event.params.to, event)
  receiver.receivedAmount = receiver.receivedAmount.plus(event.params.value)
  receiver.transferCount = receiver.transferCount.plus(ONE)
  receiver.save()

  let activity = USDCActivity.load(GLOBAL)
  if (activity == null) {
    activity = new USDCActivity(GLOBAL)
    activity.totalTransferCount = BigInt.zero()
    activity.totalVolume = BigInt.zero()
  }
  activity.totalTransferCount = activity.totalTransferCount.plus(ONE)
  activity.totalVolume = activity.totalVolume.plus(event.params.value)
  activity.lastBlock = event.block.number
  activity.lastTimestamp = event.block.timestamp
  activity.save()

  updateHour(event)
  updateDay(event)
}
