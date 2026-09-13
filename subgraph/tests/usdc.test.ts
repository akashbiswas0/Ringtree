import {
  afterAll,
  assert,
  beforeAll,
  clearStore,
  describe,
  test
} from "matchstick-as/assembly/index"
import { Address, BigInt } from "@graphprotocol/graph-ts"
import { handleTransfer } from "../src/usdc"
import { createTransferEvent } from "./usdc-utils"

const FROM = "0x0000000000000000000000000000000000000001"
const TO = "0x0000000000000000000000000000000000000002"

describe("USDC activity", () => {
  beforeAll(() => {
    handleTransfer(
      createTransferEvent(
        Address.fromString(FROM),
        Address.fromString(TO),
        BigInt.fromString("150000000000"),
        BigInt.fromI32(7200)
      )
    )
  })

  afterAll(() => clearStore())

  test("indexes transfers and account aggregates", () => {
    assert.entityCount("Transfer", 1)
    assert.entityCount("Account", 2)
    assert.fieldEquals("Account", FROM, "sentAmount", "150000000000")
    assert.fieldEquals("Account", TO, "receivedAmount", "150000000000")
    assert.fieldEquals("USDCActivity", "global", "totalTransferCount", "1")
    assert.fieldEquals("USDCActivity", "global", "totalVolume", "150000000000")
    assert.fieldEquals("USDCActivityHour", "7200", "transferCount", "1")
    assert.fieldEquals("USDCActivityHour", "7200", "volume", "150000000000")
    assert.fieldEquals("USDCActivityHour", "7200", "largeTransferCount", "1")
    assert.fieldEquals("USDCActivityHour", "7200", "whaleTransferCount", "1")
    assert.fieldEquals("USDCActivityHour", "7200", "whaleVolume", "150000000000")
    assert.fieldEquals("USDCActivityDay", "0", "transferCount", "1")
    assert.fieldEquals("USDCActivityDay", "0", "maxTransfer", "150000000000")
  })
})
