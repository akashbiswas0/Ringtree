import { BigInt, Bytes } from "@graphprotocol/graph-ts"
import { Transfer as TransferEvent } from "../generated/USDC/USDC"
import { Account, Transfer, USDCActivity } from "../generated/schema"

const ONE = BigInt.fromI32(1)
const GLOBAL = "global"

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
}
